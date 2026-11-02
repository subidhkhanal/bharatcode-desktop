import { describe, expect, test } from "bun:test"
import { editMcpForm, emptyMcpForm, pairRow, splitCommand, validateMcpForm } from "./marketplace-mcp-form"

const t = (key: string, vars?: Record<string, string | number | boolean>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key

describe("splitCommand", () => {
  test("honours quotes and keeps Windows backslashes", () => {
    expect(splitCommand('"C:\\Program Files\\node.exe" server.js --root "C:\\My Projects"')).toEqual([
      "C:\\Program Files\\node.exe",
      "server.js",
      "--root",
      "C:\\My Projects",
    ])
    expect(splitCommand("python  -m   spare mcp")).toEqual(["python", "-m", "spare", "mcp"])
    expect(splitCommand(`--name="a b" --empty '' x`)).toEqual(["--name=a b", "--empty", "", "x"])
    expect(splitCommand("   ")).toEqual([])
  })

  test("reports an unclosed quote", () => {
    expect(splitCommand('node "server.js')).toBeUndefined()
  })
})

describe("validateMcpForm", () => {
  test("builds a local server from the command line and filled rows only", () => {
    const form = {
      ...emptyMcpForm(),
      name: " notes ",
      command: "npx -y @acme/notes-mcp",
      environment: [{ ...pairRow(), key: "TOKEN", value: "{env:NOTES_TOKEN}" }, pairRow()],
      headers: [{ ...pairRow(), key: "Ignored", value: "x" }],
    }

    expect(validateMcpForm({ form, editing: false, t }).result).toEqual({
      name: "notes",
      input: {
        mode: "create",
        type: "local",
        command: ["npx", "-y", "@acme/notes-mcp"],
        environment: [{ key: "TOKEN", value: "{env:NOTES_TOKEN}" }],
      },
    })
  })

  test("an edit sends saved rows without values and leaves a blank URL out", () => {
    const form = editMcpForm({
      name: "docs",
      type: "remote",
      enabled: true,
      target: "https://mcp.example.com",
      environment: [],
      headers: ["Authorization"],
    })

    expect(validateMcpForm({ form, editing: true, t }).result).toEqual({
      name: "docs",
      input: { mode: "update", type: "remote", headers: [{ key: "Authorization" }] },
    })
  })

  test("asks for the missing parts before sending anything", () => {
    const missing = validateMcpForm({ form: emptyMcpForm(), editing: false, t })
    expect(missing.result).toBeUndefined()
    expect(missing.err).toMatchObject({ name: "marketplace.mcp.error.name", command: "marketplace.mcp.error.command" })

    const remote = validateMcpForm({
      form: { ...emptyMcpForm(), name: "web", type: "remote", headers: [{ ...pairRow(), key: "X-Key" }] },
      editing: false,
      t,
    })
    expect(remote.err).toMatchObject({
      url: "marketplace.mcp.error.url",
      headers: 'marketplace.mcp.error.value {"key":"X-Key"}',
    })

    const quote = validateMcpForm({ form: { ...emptyMcpForm(), name: "x", command: 'node "a' }, editing: false, t })
    expect(quote.err.command).toBe("marketplace.mcp.error.quote")

    const key = validateMcpForm({
      form: { ...emptyMcpForm(), name: "x", command: "node", environment: [{ ...pairRow(), value: "v" }] },
      editing: false,
      t,
    })
    expect(key.err.environment).toBe("marketplace.mcp.error.key")
  })
})
