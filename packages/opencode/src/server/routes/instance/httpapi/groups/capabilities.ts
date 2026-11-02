import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"

export const CapabilityState = Schema.Struct({
  version: Schema.Literal(1),
  installed: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
}).annotate({ identifier: "BharatCodeCapabilityState" })

export const CapabilityCatalogItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  publisher: Schema.String,
  version: Schema.String,
  category: Schema.String,
  trust: Schema.Literals(["bundled", "curated", "local"]),
  defaultEnabled: Schema.Boolean,
  requiresSetup: Schema.Boolean,
  requirements: Schema.Array(Schema.String),
  permissions: Schema.Array(Schema.String),
}).annotate({ identifier: "BharatCodeCapabilityCatalogItem" })

export const CapabilitySnapshot = Schema.Struct({
  catalog: Schema.Array(CapabilityCatalogItem),
  state: CapabilityState,
  configuration: Schema.optional(
    Schema.Struct({
      scope: Schema.Literal("runtime-defaults"),
      entries: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean, custom: Schema.Boolean })),
    }),
  ),
}).annotate({ identifier: "BharatCodeCapabilitySnapshot" })
export const CapabilityChange = Schema.Struct({
  action: Schema.Literals(["install", "enable", "disable", "uninstall"]),
}).annotate({ identifier: "BharatCodeCapabilityChange", parseOptions: { onExcessProperty: "error" } })

export const McpServer = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(["local", "remote"]),
  enabled: Schema.Boolean,
  target: Schema.String,
  environment: Schema.Array(Schema.String),
  headers: Schema.Array(Schema.String),
}).annotate({ identifier: "BharatCodeMcpServer" })

export const McpServerPair = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(128)),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
}).annotate({ identifier: "BharatCodeMcpServerPair", parseOptions: { onExcessProperty: "error" } })

export const McpServerInput = Schema.Struct({
  mode: Schema.Literals(["create", "update"]),
  type: Schema.Literals(["local", "remote"]),
  command: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(8192)))),
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  environment: Schema.optional(Schema.Array(McpServerPair)),
  headers: Schema.optional(Schema.Array(McpServerPair)),
}).annotate({ identifier: "BharatCodeMcpServerInput", parseOptions: { onExcessProperty: "error" } })

export const McpServerList = Schema.Struct({ servers: Schema.Array(McpServer) }).annotate({
  identifier: "BharatCodeMcpServerList",
})

const McpServerChange = Schema.Struct({ servers: Schema.Array(McpServer), reloadRequired: Schema.Literal(true) })
const mcpServerParams = { name: Schema.String.check(Schema.isMaxLength(64)) }

export const CapabilitiesApi = HttpApi.make("bharatcode-capabilities").add(
  HttpApiGroup.make("v2.capabilities")
    .add(HttpApiEndpoint.get("get", "/capabilities", { success: CapabilitySnapshot, error: ServiceUnavailableError }))
    .add(
      HttpApiEndpoint.post("change", "/capabilities/:id", {
        params: { id: Schema.String.check(Schema.isMaxLength(64)) },
        payload: CapabilityChange,
        success: Schema.Struct({ state: CapabilityState, reloadRequired: Schema.Literal(true) }),
        error: [InvalidRequestError, ServiceUnavailableError],
      }),
    )
    .add(
      HttpApiEndpoint.get("mcpList", "/capabilities/mcp", { success: McpServerList, error: ServiceUnavailableError }),
    )
    .add(
      HttpApiEndpoint.put("mcpSave", "/capabilities/mcp/:name", {
        params: mcpServerParams,
        payload: McpServerInput,
        success: McpServerChange,
        error: [InvalidRequestError, ServiceUnavailableError],
      }),
    )
    .add(
      HttpApiEndpoint.delete("mcpRemove", "/capabilities/mcp/:name", {
        params: mcpServerParams,
        success: McpServerChange,
        error: [InvalidRequestError, ServiceUnavailableError],
      }),
    )
    .middleware(Authorization),
)
