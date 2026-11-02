import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Capabilities } from "@opencode-ai/core/capabilities"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { BharatCodeMcpServers } from "@/bharatcode/mcp-servers"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"

const catalog = Capabilities.catalog.map((item) => ({
  id: item.id,
  name: item.name,
  description: item.description,
  publisher: item.publisher,
  version: item.version,
  category: item.category,
  trust: item.trust as "bundled" | "curated",
  defaultEnabled: item.defaultEnabled === true,
  requiresSetup: item.requiresSetup === true,
  requirements: item.requirements,
  permissions: item.permissions,
}))
const storage = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new ServiceUnavailableError({ message: "Capability state is unavailable. Re-read state before retrying." }),
  })
// node:fs, not Bun.file: the desktop sidecar runs this server under Node.
const readConfig = () =>
  storage(() =>
    fs.readFile(BharatCodeMcpServers.file(), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    }),
  )

export const capabilitiesHandlers = HttpApiBuilder.group(InstanceHttpApi, "v2.capabilities", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const store = () => Capabilities.store({ data: Global.Path.data, desktop: Flag.OPENCODE_CLIENT === "desktop" })
    return handlers
      .handle("get", () =>
        Effect.gen(function* () {
          const state = yield* storage(() => store().read())
          const defaults = yield* config.getGlobalStrict()
          return {
            catalog,
            state,
            configuration: {
              scope: "runtime-defaults" as const,
              entries: Capabilities.configuration(state, defaults, Global.Path.data),
            },
          }
        }).pipe(
          Effect.catchCause(() =>
            Effect.fail(
              new ServiceUnavailableError({
                message: "Capability state is unavailable. Re-read state before retrying.",
              }),
            ),
          ),
        ),
      )
      .handle("change", (ctx) =>
        Effect.gen(function* () {
          if (!catalog.some((item) => item.id === ctx.params.id))
            return yield* new InvalidRequestError({ message: "Unknown BharatCode capability." })
          const state = yield* storage(() => store().change(ctx.params.id, ctx.payload.action))
          yield* config.invalidate()
          // Do not silently interrupt active sessions or claim the existing MCP
          // connections have changed. The client explicitly reloads the runtime.
          return { state, reloadRequired: true as const }
        }),
      )
      .handle("mcpList", () =>
        Effect.gen(function* () {
          const servers = BharatCodeMcpServers.list(yield* readConfig())
          if (!servers) return yield* new ServiceUnavailableError({ message: BharatCodeMcpServers.INVALID_FILE })
          return { servers }
        }),
      )
      .handle("mcpSave", (ctx) => writeConfig((text) => BharatCodeMcpServers.save(text, ctx.params.name, ctx.payload)))
      .handle("mcpRemove", (ctx) => writeConfig((text) => BharatCodeMcpServers.remove(text, ctx.params.name)))

    // Like marketplace changes, saved servers connect on the next explicit runtime reload.
    function writeConfig(change: (text: string) => { text: string } | { error: BharatCodeMcpServers.Problem }) {
      return Effect.gen(function* () {
        const result = change(yield* readConfig())
        if ("error" in result)
          return yield* new InvalidRequestError({ message: result.error.message, field: result.error.field })
        yield* storage(async () => {
          await fs.mkdir(path.dirname(BharatCodeMcpServers.file()), { recursive: true })
          await fs.writeFile(BharatCodeMcpServers.file(), result.text)
        })
        yield* config.invalidate()
        return { servers: BharatCodeMcpServers.list(result.text) ?? [], reloadRequired: true as const }
      })
    }
  }),
)
