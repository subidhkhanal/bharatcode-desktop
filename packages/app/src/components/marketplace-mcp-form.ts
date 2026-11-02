import type { BharatCodeMcpServer, BharatCodeMcpServerInput, BharatCodeMcpServerPair } from "@opencode-ai/sdk/v2"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type McpField = "name" | "command" | "url" | "environment" | "headers"

// `saved` rows already have a value on the runtime; leaving the value blank keeps it.
export type PairRow = { row: string; key: string; value: string; saved: boolean }

export type McpFormState = {
  name: string
  type: "local" | "remote"
  command: string
  url: string
  environment: PairRow[]
  headers: PairRow[]
  err: Partial<Record<McpField, string>>
}

export function emptyMcpForm(): McpFormState {
  return { name: "", type: "local", command: "", url: "", environment: [], headers: [], err: {} }
}

// The runtime never sends commands, URLs or values back, so an edit starts from names only.
export function editMcpForm(server: BharatCodeMcpServer): McpFormState {
  const saved = (key: string) => ({ row: nextRow(), key, value: "", saved: true })
  return {
    ...emptyMcpForm(),
    name: server.name,
    type: server.type,
    environment: server.environment.map(saved),
    headers: server.headers.map(saved),
  }
}

export function validateMcpForm(input: { form: McpFormState; editing: boolean; t: Translator }) {
  const form = input.form
  const t = input.t
  const command = splitCommand(form.command)
  const environment = pairs(form.environment, t)
  const headers = pairs(form.headers, t)
  const err: McpFormState["err"] = {
    name: !form.name.trim() ? t("marketplace.mcp.error.name") : undefined,
    command:
      form.type !== "local"
        ? undefined
        : !command
          ? t("marketplace.mcp.error.quote")
          : !command.length && !input.editing
            ? t("marketplace.mcp.error.command")
            : undefined,
    url: form.type === "remote" && !form.url.trim() && !input.editing ? t("marketplace.mcp.error.url") : undefined,
    environment: form.type === "local" && "error" in environment ? environment.error : undefined,
    headers: form.type === "remote" && "error" in headers ? headers.error : undefined,
  }
  if (Object.values(err).some(Boolean)) return { err }
  const result: BharatCodeMcpServerInput =
    form.type === "local"
      ? {
          mode: input.editing ? "update" : "create",
          type: "local",
          ...(command?.length ? { command } : {}),
          environment: "rows" in environment ? environment.rows : [],
        }
      : {
          mode: input.editing ? "update" : "create",
          type: "remote",
          ...(form.url.trim() ? { url: form.url.trim() } : {}),
          headers: "rows" in headers ? headers.rows : [],
        }
  return { err, result: { name: form.name.trim(), input: result } }
}

// Splits on spaces and honours quotes like a shell, but keeps backslashes so Windows paths paste unchanged.
export function splitCommand(input: string) {
  const result = [...input].reduce<{ args: string[]; current?: string; quote?: string }>(
    (state, char) => {
      if (state.quote) {
        if (char === state.quote) return { ...state, quote: undefined }
        return { ...state, current: (state.current ?? "") + char }
      }
      if (char === '"' || char === "'") return { ...state, quote: char, current: state.current ?? "" }
      if (/\s/.test(char)) {
        if (state.current === undefined) return state
        return { args: [...state.args, state.current] }
      }
      return { ...state, current: (state.current ?? "") + char }
    },
    { args: [] },
  )
  if (result.quote) return
  return result.current === undefined ? result.args : [...result.args, result.current]
}

function pairs(rows: PairRow[], t: Translator): { rows: BharatCodeMcpServerPair[] } | { error: string } {
  const filled = rows
    .map((row) => ({ key: row.key.trim(), value: row.value, saved: row.saved }))
    .filter((row) => row.key || row.value)
  const missingKey = filled.find((row) => !row.key)
  if (missingKey) return { error: t("marketplace.mcp.error.key") }
  const missingValue = filled.find((row) => !row.value && !row.saved)
  if (missingValue) return { error: t("marketplace.mcp.error.value", { key: missingValue.key }) }
  return { rows: filled.map((row) => (row.value ? { key: row.key, value: row.value } : { key: row.key })) }
}

let row = 0

const nextRow = () => `mcp-row-${row++}`

export const pairRow = (): PairRow => ({ row: nextRow(), key: "", value: "", saved: false })
