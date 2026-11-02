import { afterEach, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { parse } from "jsonc-parser"

const state = path.join(Global.Path.data, "bharatcode-capabilities.json")
const config = path.join(Global.Path.config, "opencode.jsonc")
const auth = { authorization: `Basic ${Buffer.from("bharatcode:secret").toString("base64")}` }
const handlers: Array<{ dispose: () => Promise<void> }> = []
function app() {
  const server = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ OPENCODE_SERVER_USERNAME: "bharatcode", OPENCODE_SERVER_PASSWORD: "secret" }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  handlers.push(server)
  return (route: string, init?: RequestInit) =>
    server.handler(new Request(`http://localhost${route}`, init), HttpApiApp.context)
}
afterEach(async () => {
  await Promise.all(handlers.splice(0).map((handler) => handler.dispose()))
  await rm(state, { force: true })
  await rm(config, { force: true })
})
const action = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify(body),
})
const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify(body),
})
function sdk(request: ReturnType<typeof app>) {
  return createOpencodeClient({
    baseUrl: "http://localhost",
    headers: auth,
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const source = input instanceof Request ? input : new Request(input)
        return request(new URL(source.url).pathname, {
          method: source.method,
          headers: source.headers,
          body: source.method === "GET" || source.method === "DELETE" ? undefined : await source.text(),
        })
      },
      { preconnect: fetch.preconnect },
    ),
  })
}

test("marketplace read and writes require sidecar authorization", async () => {
  const request = app()
  expect((await request("/capabilities")).status).toBe(401)
  expect((await request("/capabilities/github", { method: "POST" })).status).toBe(401)
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.catalog).toHaveLength(9)
  expect(body.state).toEqual({ version: 1, installed: {} })
  expect(body.configuration.scope).toBe("runtime-defaults")
  expect(body.configuration.entries.github).toEqual({ enabled: false, custom: false })
  expect(JSON.stringify(body)).not.toMatch(/clientSecret|environment|command|headers|\/home\//)
})

test("runtime configuration overrides are projected safely, not reported as connection health", async () => {
  await writeFile(
    config,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { github: { type: "remote", url: "https://private.invalid", headers: { Authorization: "private-token" } } },
    }),
  )
  const request = app()
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.state.installed).toEqual({})
  expect(body.configuration).toMatchObject({
    scope: "runtime-defaults",
    entries: { github: { enabled: true, custom: true } },
  })
  expect(JSON.stringify(body)).not.toMatch(/private-token|private.invalid|connected/)
})

test("invalid runtime configuration cannot masquerade as disabled marketplace defaults", async () => {
  await writeFile(config, "{invalid: private-token}")
  const request = app()
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(503)
  expect(await response.text()).not.toMatch(/private-token|opencode.jsonc/)
  await writeFile(config, '{"$schema":"https://opencode.ai/config.json"}')
  expect((await request("/capabilities", { headers: auth })).status).toBe(200)
})

test("install stays disabled, uninstall persists, and reload is explicit", async () => {
  const request = app()
  const installed = await request("/capabilities/github", action({ action: "install" }))
  expect(installed.status).toBe(200)
  expect(await installed.json()).toMatchObject({
    state: { installed: { github: { enabled: false } } },
    reloadRequired: true,
  })
  const reread = await request("/capabilities", { headers: auth })
  expect(await reread.json()).toMatchObject({ state: { installed: { github: { enabled: false } } } })
  const removed = await request("/capabilities/github", action({ action: "uninstall" }))
  expect(removed.status).toBe(200)
  expect((await removed.json()).state.installed).toEqual({})
})

test("generated SDK reads and changes marketplace state through the protected handler", async () => {
  const client = sdk(app())
  expect((await client.v2.capabilities.get({ throwOnError: true })).data.state.installed).toEqual({})
  const result = await client.v2.capabilities.change(
    { id: "github", bharatCodeCapabilityChange: { action: "enable" } },
    { throwOnError: true },
  )
  expect(result.data).toEqual({ state: { version: 1, installed: { github: { enabled: true } } }, reloadRequired: true })
  const enabled = (await client.v2.capabilities.get({ throwOnError: true })).data
  expect(enabled.state.installed.github.enabled).toBe(true)
  expect(enabled.configuration?.entries.github).toEqual({ enabled: true, custom: false })
})

test("custom MCP servers need authorization and save to the global config without echoing secrets", async () => {
  const request = app()
  expect((await request("/capabilities/mcp")).status).toBe(401)
  expect((await request("/capabilities/mcp/notes", { method: "PUT" })).status).toBe(401)
  expect((await request("/capabilities/mcp/notes", { method: "DELETE" })).status).toBe(401)

  const saved = await request(
    "/capabilities/mcp/notes",
    put({
      mode: "create",
      type: "local",
      command: ["node", "server.js", "--token", "argument-secret"],
      environment: [{ key: "TOKEN", value: "env-secret" }],
    }),
  )
  expect(saved.status).toBe(200)
  const body = await saved.json()
  expect(body).toEqual({
    servers: [{ name: "notes", type: "local", enabled: true, target: "node", environment: ["TOKEN"], headers: [] }],
    reloadRequired: true,
  })
  expect(JSON.stringify(body)).not.toMatch(/secret|server\.js/)
  expect(parse(await Bun.file(config).text()).mcp.notes).toEqual({
    type: "local",
    command: ["node", "server.js", "--token", "argument-secret"],
    environment: { TOKEN: "env-secret" },
  })
  expect((await (await request("/capabilities/mcp", { headers: auth })).json()).servers).toEqual(body.servers)

  const removed = await request("/capabilities/mcp/notes", { method: "DELETE", headers: auth })
  expect(removed.status).toBe(200)
  expect((await removed.json()).servers).toEqual([])
  expect(parse(await Bun.file(config).text()).mcp).toEqual({})
})

test("invalid custom MCP servers are rejected with a message, and a broken config is never rewritten", async () => {
  const request = app()
  const local = { mode: "create", type: "local", command: ["node"] }
  expect((await request("/capabilities/mcp/notes", put({ ...local, cwd: "/elsewhere" }))).status).toBe(400)
  expect((await request("/capabilities/mcp/notes", put({ ...local, mode: "replace" }))).status).toBe(400)

  const http = await request(
    "/capabilities/mcp/web",
    put({ mode: "create", type: "remote", url: "http://mcp.example" }),
  )
  expect(http.status).toBe(400)
  expect(await http.text()).toContain("Use https://")
  const reserved = await request("/capabilities/mcp/github", put(local))
  expect(reserved.status).toBe(400)
  expect(await reserved.text()).toContain("Marketplace connector")

  await writeFile(config, "{invalid: private-token}")
  const listed = await request("/capabilities/mcp", { headers: auth })
  expect(listed.status).toBe(503)
  expect(await listed.text()).not.toMatch(/private-token|opencode.jsonc/)
  expect((await request("/capabilities/mcp/notes", put(local))).status).toBe(400)
  expect(await Bun.file(config).text()).toBe("{invalid: private-token}")
})

test("generated SDK saves, edits and removes custom MCP servers", async () => {
  const client = sdk(app())
  await client.v2.capabilities.mcpSave(
    {
      name: "docs",
      bharatCodeMcpServerInput: {
        mode: "create",
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: [{ key: "Authorization", value: "Bearer header-secret" }],
      },
    },
    { throwOnError: true },
  )
  // A header sent without a value keeps the saved one, so the form never needs the secret back.
  const edited = await client.v2.capabilities.mcpSave(
    {
      name: "docs",
      bharatCodeMcpServerInput: { mode: "update", type: "remote", headers: [{ key: "Authorization" }] },
    },
    { throwOnError: true },
  )
  expect(edited.data.servers).toEqual([
    {
      name: "docs",
      type: "remote",
      enabled: true,
      target: "https://mcp.example.com",
      environment: [],
      headers: ["Authorization"],
    },
  ])
  expect(parse(await Bun.file(config).text()).mcp.docs.headers).toEqual({ Authorization: "Bearer header-secret" })
  await client.v2.capabilities.mcpRemove({ name: "docs" }, { throwOnError: true })
  expect((await client.v2.capabilities.mcpList({ throwOnError: true })).data.servers).toEqual([])
})

test("invalid actions and unknown IDs are rejected; storage errors expose no payload", async () => {
  const request = app()
  expect(
    (await request("/capabilities/github", action({ action: "enable", url: "https://secret.invalid" }))).status,
  ).toBe(400)
  expect((await request("/capabilities/github", action({ action: "run" }))).status).toBe(400)
  expect((await request("/capabilities/not-known", action({ action: "enable" }))).status).toBe(400)
  await writeFile(state, "private-token=/private/source", { mode: 0o600 })
  const response = await request("/capabilities", { headers: auth })
  expect(response.status).toBe(503)
  const body = await response.text()
  expect(body).toContain("Capability state is unavailable")
  expect(body).not.toMatch(/private-token|\/private\/source|\/home\//)
})
