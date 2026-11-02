import { describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { BharatCodeMcpServers } from "@/bharatcode/mcp-servers"

const base = `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "github": { "type": "remote", "url": "https://api.githubcopilot.com/mcp/" },
    "spare-gpu": {
      "type": "local",
      "command": ["C:\\\\tools\\\\venv\\\\python.exe", "-m", "spare", "--token", "argument-secret"],
      "environment": { "API_KEY": "env-secret", "MODE": "fast" },
      "cwd": "C:\\\\tools",
      "timeout": 9000
    }
  }
}`

function saved(text: string, name: string, input: BharatCodeMcpServers.Input) {
  const result = BharatCodeMcpServers.save(text, name, input)
  if ("error" in result) throw new Error(result.error.message)
  return result.text
}

function problem(text: string, name: string, input: BharatCodeMcpServers.Input) {
  const result = BharatCodeMcpServers.save(text, name, input)
  return "error" in result ? result.error : undefined
}

const mcp = (text: string) => parse(text).mcp

describe("BharatCodeMcpServers", () => {
  test("lists custom servers without arguments, URL paths or secret values", () => {
    const text = saved(base, "docs", {
      mode: "create",
      type: "remote",
      url: "https://mcp.example.com/v1?key=query-secret",
      headers: [{ key: "Authorization", value: "Bearer header-secret" }],
    })
    const servers = BharatCodeMcpServers.list(text)!

    // Marketplace connectors stay in the Marketplace list.
    expect(servers.map((server) => server.name)).toEqual(["docs", "spare-gpu"])
    expect(servers[1]).toEqual({
      name: "spare-gpu",
      type: "local",
      enabled: true,
      target: "python.exe",
      environment: ["API_KEY", "MODE"],
      headers: [],
    })
    expect(servers[0]).toMatchObject({ target: "https://mcp.example.com", headers: ["Authorization"] })
    expect(JSON.stringify(servers)).not.toMatch(/secret|\/v1|-m/)
  })

  test("adds a local server and keeps the file's comments", () => {
    const text = saved(base, "notes", {
      mode: "create",
      type: "local",
      command: ["npx", "-y", "@acme/notes-mcp"],
      environment: [{ key: "NOTES_TOKEN", value: "{env:NOTES_TOKEN}" }],
    })

    expect(text).toContain("// my settings")
    expect(mcp(text).notes).toEqual({
      type: "local",
      command: ["npx", "-y", "@acme/notes-mcp"],
      environment: { NOTES_TOKEN: "{env:NOTES_TOKEN}" },
    })
    expect(mcp(text)["spare-gpu"]).toEqual(mcp(base)["spare-gpu"])
  })

  test("an edit keeps the saved command and values left blank, and settings the form does not show", () => {
    const text = saved(base, "spare-gpu", {
      mode: "update",
      type: "local",
      environment: [{ key: "API_KEY" }, { key: "LEVEL", value: "2" }],
    })

    expect(mcp(text)["spare-gpu"]).toEqual({
      type: "local",
      command: ["C:\\tools\\venv\\python.exe", "-m", "spare", "--token", "argument-secret"],
      environment: { API_KEY: "env-secret", LEVEL: "2" },
      cwd: "C:\\tools",
      timeout: 9000,
    })
  })

  test("switching a server to remote drops the local settings but keeps its timeout", () => {
    const text = saved(base, "spare-gpu", { mode: "update", type: "remote", url: "http://127.0.0.1:8080/mcp" })

    expect(mcp(text)["spare-gpu"]).toEqual({ type: "remote", url: "http://127.0.0.1:8080/mcp", timeout: 9000 })
  })

  test("rejects names that are taken, reserved or unsafe", () => {
    const local = { type: "local", command: ["node", "server.js"] } as const

    expect(problem(base, "spare-gpu", { mode: "create", ...local })?.message).toContain("already exists")
    expect(problem(base, "github", { mode: "create", ...local })?.message).toContain("Marketplace connector")
    expect(problem(base, "bad name", { mode: "create", ...local })?.field).toBe("name")
    expect(problem(base, "missing", { mode: "update", ...local })?.message).toContain("no longer in your config")
  })

  test("only allows plain http for servers on this computer, and no credentials in the URL", () => {
    const remote = (url: string) => problem(base, "web", { mode: "create", type: "remote", url })

    expect(remote("http://mcp.example.com/mcp")?.message).toContain("Use https://")
    expect(remote("https://user:pass@mcp.example.com/mcp")?.message).toContain("username or password")
    expect(remote("not a url")?.field).toBe("url")
    expect(remote("http://localhost:3000/mcp")).toBeUndefined()
    expect(remote("https://mcp.example.com/mcp")).toBeUndefined()
  })

  test("rejects invalid, duplicate, empty or multi-line headers and variables", () => {
    const header = (headers: BharatCodeMcpServers.Pair[]) =>
      problem(base, "web", { mode: "create", type: "remote", url: "https://mcp.example.com", headers })

    expect(header([{ key: "Bad Header", value: "x" }])?.field).toBe("headers")
    expect(
      header([
        { key: "X-Key", value: "a" },
        { key: "x-key", value: "b" },
      ])?.message,
    ).toContain("more than once")
    expect(header([{ key: "X-Key" }])?.message).toBe("Enter a value for X-Key.")
    expect(header([{ key: "X-Key", value: "a\r\nInjected: yes" }])?.message).toContain("invalid characters")
    expect(
      problem(base, "cli", {
        mode: "create",
        type: "local",
        command: ["node"],
        environment: [{ key: "1BAD", value: "x" }],
      })?.field,
    ).toBe("environment")
    expect(problem(base, "cli", { mode: "create", type: "local", command: [" "] })?.field).toBe("command")
  })

  test("removes only the named server", () => {
    const result = BharatCodeMcpServers.remove(base, "spare-gpu")
    if ("error" in result) throw new Error(result.error.message)

    expect(Object.keys(mcp(result.text))).toEqual(["github"])
    expect(result.text).toContain("// my settings")
    expect(BharatCodeMcpServers.remove(base, "github")).toMatchObject({ error: { field: "name" } })
  })

  test("refuses to edit a config file that has errors, and starts an empty one", () => {
    expect(BharatCodeMcpServers.list("{ broken")).toBeUndefined()
    expect(BharatCodeMcpServers.save("{ broken", "x", { mode: "create", type: "local", command: ["x"] })).toEqual({
      error: { message: BharatCodeMcpServers.INVALID_FILE },
    })
    expect(mcp(saved("", "x", { mode: "create", type: "local", command: ["x"] }))).toEqual({
      x: { type: "local", command: ["x"] },
    })
  })
})
