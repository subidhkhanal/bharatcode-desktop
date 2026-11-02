import path from "node:path"
import { existsSync } from "node:fs"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Capabilities } from "@opencode-ai/core/capabilities"
import { Global } from "@opencode-ai/core/global"
import { isRecord } from "@/util/record"

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
// RFC 9110 token characters.
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
const MAX_ARGS = 64
const MAX_PAIRS = 64
const MAX_TEXT = 8192
const MAX_URL = 2048

// Marketplace connectors are managed from their catalog entry, so the custom list never claims their names.
const reserved = new Set(
  Capabilities.catalog.flatMap((item) =>
    item.modules.flatMap((module) => (module.type === "mcp" && "name" in module ? [module.name] : [])),
  ),
)

export type Pair = { readonly key: string; readonly value?: string }
export type Input = {
  readonly mode: "create" | "update"
  readonly type: "local" | "remote"
  readonly command?: readonly string[]
  readonly url?: string
  readonly environment?: readonly Pair[]
  readonly headers?: readonly Pair[]
}
// Only names and a coarse target leave the runtime: never arguments, URL paths, queries or secret values.
export type Summary = {
  name: string
  type: "local" | "remote"
  enabled: boolean
  target: string
  environment: string[]
  headers: string[]
}
export type Problem = { field?: string; message: string }

export const INVALID_FILE = "Your global config file has errors. Fix it in a text editor, then refresh."

// Matches the file Config.updateGlobal writes, so the form and the runtime edit the same config.
export function file() {
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((name) =>
    path.join(Global.Path.config, name),
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function list(text: string): Summary[] | undefined {
  const config = read(text)
  if (!config) return
  return Object.entries(servers(config))
    .filter((entry): entry is [string, Record<string, unknown>] => !reserved.has(entry[0]) && isServer(entry[1]))
    .map(([name, entry]) => summary(name, entry))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function save(text: string, name: string, input: Input): { text: string } | { error: Problem } {
  const config = read(text)
  if (!config) return { error: { message: INVALID_FILE } }
  if (!NAME.test(name)) return fail("name", "Use up to 32 letters, numbers, - or _, starting with a letter or number.")
  if (reserved.has(name)) return fail("name", `"${name}" is a Marketplace connector. Manage it from its entry above.`)
  const existing = servers(config)[name]
  if (input.mode === "create" && existing !== undefined) return fail("name", "A server with this name already exists.")
  if (input.mode === "update" && !isServer(existing))
    return fail("name", "This server is no longer in your config. Refresh and try again.")
  const previous = isServer(existing) ? existing : undefined
  const entry = input.type === "local" ? local(input, previous) : remote(input, previous)
  if ("error" in entry) return entry
  return { text: write(text, ["mcp", name], entry.value) }
}

export function remove(text: string, name: string): { text: string } | { error: Problem } {
  const config = read(text)
  if (!config) return { error: { message: INVALID_FILE } }
  if (reserved.has(name) || !isServer(servers(config)[name]))
    return fail("name", "This server is no longer in your config. Refresh and try again.")
  return { text: write(text, ["mcp", name], undefined) }
}

function local(input: Input, previous: Record<string, unknown> | undefined) {
  const same = previous?.type === "local" ? previous : undefined
  const command = input.command?.length ? input.command : strings(same?.command)
  if (!command?.length || !command[0].trim()) return fail("command", "Enter the command that starts the server.")
  if (
    input.command?.length &&
    (command.length > MAX_ARGS || command.some((arg) => arg.length > MAX_TEXT || arg.includes("\0")))
  )
    return fail("command", `Use at most ${MAX_ARGS} arguments without control characters.`)
  const environment = pairs(input.environment ?? [], same?.environment, "environment")
  if ("error" in environment) return environment
  return {
    value: {
      ...kept(previous, same),
      type: "local",
      command: [...command],
      ...(Object.keys(environment.value).length ? { environment: environment.value } : {}),
    },
  }
}

function remote(input: Input, previous: Record<string, unknown> | undefined) {
  const same = previous?.type === "remote" ? previous : undefined
  const typed = input.url?.trim()
  const url = typed || (typeof same?.url === "string" ? same.url : undefined)
  if (!url) return fail("url", "Enter the server URL.")
  const problem = typed ? urlProblem(typed) : undefined
  if (problem) return fail("url", problem)
  const headers = pairs(input.headers ?? [], same?.headers, "headers")
  if ("error" in headers) return headers
  return {
    value: {
      ...kept(previous, same),
      type: "remote",
      url,
      ...(Object.keys(headers.value).length ? { headers: headers.value } : {}),
    },
  }
}

// Settings the form does not show (working directory, OAuth, timeout) survive an edit of the same server type.
function kept(previous: Record<string, unknown> | undefined, same: Record<string, unknown> | undefined) {
  if (same) {
    const { command: _command, url: _url, environment: _environment, headers: _headers, ...rest } = same
    return rest
  }
  return {
    ...(typeof previous?.enabled === "boolean" ? { enabled: previous.enabled } : {}),
    ...(typeof previous?.timeout === "number" ? { timeout: previous.timeout } : {}),
  }
}

function urlProblem(url: string) {
  if (url.length > MAX_URL || !URL.canParse(url)) return "Enter a full URL, like https://example.com/mcp."
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)))
    return "Use https://. Plain http:// is only allowed for servers on this computer."
  if (parsed.username || parsed.password) return "Don't put a username or password in the URL. Use a header instead."
}

// A row without a value keeps the value already saved for that key, so secrets never have to be sent back to the form.
function pairs(rows: readonly Pair[], previous: unknown, field: "environment" | "headers") {
  if (rows.length > MAX_PAIRS) return fail(field, `Use at most ${MAX_PAIRS} entries.`)
  const old = isRecord(previous) ? previous : {}
  const pattern = field === "environment" ? ENV_KEY : HEADER_KEY
  const normal = (key: string) => (field === "headers" ? key.toLowerCase() : key)
  const resolved = rows.map((row) => ({
    key: row.key.trim(),
    value: row.value ?? (typeof old[row.key.trim()] === "string" ? (old[row.key.trim()] as string) : undefined),
  }))
  const problem = resolved
    .map((row, index) => {
      if (!pattern.test(row.key))
        return field === "environment"
          ? `"${row.key}" is not a valid variable name. Use letters, numbers and _.`
          : `"${row.key}" is not a valid header name.`
      if (resolved.findIndex((other) => normal(other.key) === normal(row.key)) !== index)
        return `"${row.key}" is listed more than once.`
      if (row.value === undefined || row.value === "") return `Enter a value for ${row.key}.`
      if (row.value.length > MAX_TEXT || /[\0\r\n]/.test(row.value))
        return `The value for ${row.key} has invalid characters.`
    })
    .find((message) => message !== undefined)
  if (problem) return fail(field, problem)
  return { value: Object.fromEntries(resolved.map((row) => [row.key, row.value!])) }
}

function summary(name: string, entry: Record<string, unknown>): Summary {
  if (entry.type === "local")
    return {
      name,
      type: "local",
      enabled: entry.enabled !== false,
      target: path.win32.basename(strings(entry.command)?.[0] ?? ""),
      environment: isRecord(entry.environment) ? Object.keys(entry.environment) : [],
      headers: [],
    }
  return {
    name,
    type: "remote",
    enabled: entry.enabled !== false,
    target: typeof entry.url === "string" && URL.canParse(entry.url) ? new URL(entry.url).origin : "",
    environment: [],
    headers: isRecord(entry.headers) ? Object.keys(entry.headers) : [],
  }
}

function read(text: string) {
  const errors: ParseError[] = []
  const value: unknown = parse(text.trim() ? text : "{}", errors, { allowTrailingComma: true })
  if (errors.length || !isRecord(value)) return
  if (value.mcp !== undefined && !isRecord(value.mcp)) return
  return value
}

function servers(config: Record<string, unknown>) {
  return isRecord(config.mcp) ? config.mcp : {}
}

function isServer(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && (entry.type === "local" || entry.type === "remote")
}

function strings(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined
}

function write(text: string, keys: string[], value: unknown) {
  const base = text.trim() ? text : "{}"
  return applyEdits(base, modify(base, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
}

function fail(field: string, message: string) {
  return { error: { field, message } }
}

export * as BharatCodeMcpServers from "./mcp-servers"
