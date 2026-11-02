import { batch, createEffect, For, on, Show } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import type { BharatCodeMcpServer } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { MarketplaceAction } from "./marketplace-action"
import {
  editMcpForm,
  emptyMcpForm,
  pairRow,
  validateMcpForm,
  type McpField,
  type McpFormState,
  type PairRow,
} from "./marketplace-mcp-form"

const FIELDS = new Set<string>(["name", "command", "url", "environment", "headers"])

export function MarketplaceMcpServers(props: { v2?: boolean; refreshed: number; onChanged: () => void }) {
  const runtime = useServerSDK()
  const language = useLanguage()
  const [state, setState] = createStore<{
    servers?: BharatCodeMcpServer[]
    loading: boolean
    busy: boolean
    error?: string
    // undefined: no form open; "": adding a new server; otherwise the name being edited.
    editing?: string
    confirmRemove?: string
  }>({ loading: false, busy: false })
  const [form, setForm] = createStore<McpFormState>(emptyMcpForm())
  let generation = 0

  const load = async () => {
    const attempt = ++generation
    setState({ loading: true, error: undefined })
    const result = await runtime()
      .client.v2.capabilities.mcpList()
      .catch(() => undefined)
    if (attempt !== generation) return
    setState({
      loading: false,
      servers: result?.data?.servers,
      error: result?.data ? undefined : language.t("marketplace.mcp.error.load"),
    })
  }

  createEffect(
    on(runtime, () => {
      setState({ editing: undefined, confirmRemove: undefined, servers: undefined })
      void load()
    }),
  )
  createEffect(
    on(
      () => props.refreshed,
      () => void load(),
      { defer: true },
    ),
  )

  const open = (server?: BharatCodeMcpServer) => {
    setForm(server ? editMcpForm(server) : emptyMcpForm())
    setState({ editing: server?.name ?? "", confirmRemove: undefined, error: undefined })
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.busy) return
    const output = validateMcpForm({ form, editing: !!state.editing, t: language.t })
    setForm("err", output.err)
    if (!output.result) return
    const attempt = ++generation
    setState({ busy: true, error: undefined })
    const response = await runtime()
      .client.v2.capabilities.mcpSave({ name: output.result.name, bharatCodeMcpServerInput: output.result.input })
      .catch(() => undefined)
    if (attempt !== generation) return
    setState("busy", false)
    if (response?.data) {
      setState({ servers: response.data.servers, editing: undefined })
      props.onChanged()
      return
    }
    const error = response?.error
    const message = error?.message ?? language.t("marketplace.mcp.error.save")
    const field = error && "field" in error ? error.field : undefined
    if (field && FIELDS.has(field)) {
      setForm("err", field as McpField, message)
      return
    }
    setState("error", message)
  }

  const remove = async (name: string) => {
    if (state.busy) return
    const attempt = ++generation
    setState({ busy: true, confirmRemove: undefined, error: undefined })
    const response = await runtime()
      .client.v2.capabilities.mcpRemove({ name })
      .catch(() => undefined)
    if (attempt !== generation) return
    setState("busy", false)
    if (!response?.data) {
      setState("error", response?.error?.message ?? language.t("marketplace.mcp.error.remove"))
      return
    }
    setState("servers", response.data.servers)
    props.onChanged()
  }

  const setField = (key: "name" | "command" | "url", value: string) =>
    batch(() => {
      setForm(key, value)
      setForm("err", key, undefined)
    })

  const setType = (type: McpFormState["type"]) =>
    batch(() => {
      setForm("type", type)
      setForm("err", {})
    })

  return (
    <section
      class="flex flex-col gap-3"
      aria-labelledby="marketplace-mcp-title"
      aria-busy={state.loading || state.busy}
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 id="marketplace-mcp-title" class="text-14-medium text-text-strong">
          {language.t("marketplace.mcp.title")}
        </h3>
        <Show when={state.editing === undefined}>
          <MarketplaceAction v2={props.v2} disabled={state.busy || !state.servers} onClick={() => open()}>
            {language.t("marketplace.mcp.add")}
          </MarketplaceAction>
        </Show>
      </div>
      <p class="text-13-regular text-text-base">{language.t("marketplace.mcp.description")}</p>
      <Show when={state.error}>
        {(error) => (
          <p role="alert" class="text-13-regular text-text-strong">
            {error()}
          </p>
        )}
      </Show>

      <Show when={state.editing !== undefined}>
        <form
          onSubmit={save}
          class="flex flex-col gap-4 p-4 rounded-md border border-border-weak-base"
          aria-label={language.t(state.editing ? "marketplace.mcp.editName" : "marketplace.mcp.add", {
            name: state.editing ?? "",
          })}
        >
          <TextField
            autofocus={!state.editing}
            label={language.t("marketplace.mcp.field.name")}
            description={language.t("marketplace.mcp.field.name.description")}
            placeholder="my-server"
            value={form.name}
            disabled={!!state.editing}
            onChange={(value) => setField("name", value)}
            validationState={form.err.name ? "invalid" : undefined}
            error={form.err.name}
          />
          <div class="flex flex-col gap-2" role="group" aria-label={language.t("marketplace.mcp.field.type")}>
            <span class="text-12-medium text-text-weak">{language.t("marketplace.mcp.field.type")}</span>
            <div class="flex flex-wrap gap-2">
              <MarketplaceAction v2={props.v2} pressed={form.type === "local"} onClick={() => setType("local")}>
                {language.t("marketplace.mcp.type.local")}
              </MarketplaceAction>
              <MarketplaceAction v2={props.v2} pressed={form.type === "remote"} onClick={() => setType("remote")}>
                {language.t("marketplace.mcp.type.remote")}
              </MarketplaceAction>
            </div>
          </div>
          <Show
            when={form.type === "local"}
            fallback={
              <>
                <TextField
                  label={language.t("marketplace.mcp.field.url")}
                  description={language.t("marketplace.mcp.field.url.description")}
                  placeholder={state.editing ? language.t("marketplace.mcp.keepSaved") : "https://example.com/mcp"}
                  value={form.url}
                  onChange={(value) => setField("url", value)}
                  validationState={form.err.url ? "invalid" : undefined}
                  error={form.err.url}
                />
                <PairRows field="headers" rows={form.headers} error={form.err.headers} setForm={setForm} />
              </>
            }
          >
            <TextField
              label={language.t("marketplace.mcp.field.command")}
              description={language.t("marketplace.mcp.field.command.description")}
              placeholder={
                state.editing
                  ? language.t("marketplace.mcp.keepSaved")
                  : 'npx -y @modelcontextprotocol/server-filesystem "C:\\My Projects"'
              }
              value={form.command}
              onChange={(value) => setField("command", value)}
              validationState={form.err.command ? "invalid" : undefined}
              error={form.err.command}
            />
            <PairRows field="environment" rows={form.environment} error={form.err.environment} setForm={setForm} />
          </Show>
          <div class="flex flex-wrap gap-2">
            <MarketplaceAction v2={props.v2} type="submit" pressed disabled={state.busy}>
              {language.t(state.busy ? "marketplace.mcp.saving" : "marketplace.mcp.save")}
            </MarketplaceAction>
            <MarketplaceAction v2={props.v2} disabled={state.busy} onClick={() => setState("editing", undefined)}>
              {language.t("common.cancel")}
            </MarketplaceAction>
          </div>
        </form>
      </Show>

      <Show
        when={state.servers}
        fallback={
          <p role="status" class="text-13-regular text-text-base">
            {language.t(state.loading ? "marketplace.mcp.loading" : "marketplace.mcp.unavailable")}
          </p>
        }
      >
        {(servers) => (
          <Show
            when={servers().length}
            fallback={<p class="text-13-regular text-text-base">{language.t("marketplace.mcp.empty")}</p>}
          >
            <ul class="flex flex-col">
              <For each={servers()}>
                {(server) => (
                  <li
                    class="flex flex-wrap justify-between gap-4 py-3 border-b border-border-weak-base last:border-none"
                    aria-label={server.name}
                  >
                    <div class="flex-1 min-w-[160px] flex flex-col gap-1">
                      <span class="text-14-medium text-text-strong break-words">{server.name}</span>
                      <span class="text-12-regular text-text-base break-words">
                        {[
                          language.t(
                            server.type === "local" ? "marketplace.mcp.type.local" : "marketplace.mcp.type.remote",
                          ),
                          server.target,
                          server.enabled ? undefined : language.t("marketplace.mcp.off"),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <Show when={[...server.environment, ...server.headers].length}>
                        <span class="text-12-regular text-text-base break-words">
                          {language.t(
                            server.type === "local"
                              ? "marketplace.mcp.savedEnvironment"
                              : "marketplace.mcp.savedHeaders",
                            { keys: [...server.environment, ...server.headers].join(", ") },
                          )}
                        </span>
                      </Show>
                    </div>
                    <div class="flex flex-wrap items-start gap-2">
                      <Show
                        when={state.confirmRemove === server.name}
                        fallback={
                          <>
                            <MarketplaceAction
                              v2={props.v2}
                              disabled={state.busy || state.editing !== undefined}
                              label={language.t("marketplace.mcp.editName", { name: server.name })}
                              onClick={() => open(server)}
                            >
                              {language.t("marketplace.mcp.edit")}
                            </MarketplaceAction>
                            <MarketplaceAction
                              v2={props.v2}
                              disabled={state.busy || state.editing !== undefined}
                              label={language.t("marketplace.removeName", { name: server.name })}
                              onClick={() => setState("confirmRemove", server.name)}
                            >
                              {language.t("marketplace.remove")}
                            </MarketplaceAction>
                          </>
                        }
                      >
                        <span class="text-12-regular text-text-base self-center">
                          {language.t("marketplace.mcp.confirmRemove", { name: server.name })}
                        </span>
                        <MarketplaceAction
                          v2={props.v2}
                          pressed
                          disabled={state.busy}
                          label={language.t("marketplace.removeName", { name: server.name })}
                          onClick={() => void remove(server.name)}
                        >
                          {language.t("marketplace.remove")}
                        </MarketplaceAction>
                        <MarketplaceAction v2={props.v2} onClick={() => setState("confirmRemove", undefined)}>
                          {language.t("common.cancel")}
                        </MarketplaceAction>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  )
}

function PairRows(props: {
  field: "environment" | "headers"
  rows: PairRow[]
  error?: string
  setForm: SetStoreFunction<McpFormState>
}) {
  const language = useLanguage()
  const prefix = () => `marketplace.mcp.${props.field}`
  const setRow = (index: number, key: "key" | "value", value: string) =>
    batch(() => {
      props.setForm(props.field, index, key, value)
      // A renamed key no longer has a saved value to keep.
      if (key === "key") props.setForm(props.field, index, "saved", false)
      props.setForm("err", props.field, undefined)
    })
  return (
    <div class="flex flex-col gap-2">
      <span class="text-12-medium text-text-weak">{language.t(`${prefix()}.label`)}</span>
      <For each={props.rows}>
        {(row, index) => (
          <div class="flex gap-2 items-start" data-row={row.row}>
            <div class="flex-1">
              <TextField
                label={language.t(`${prefix()}.key`)}
                hideLabel
                placeholder={language.t(`${prefix()}.key`)}
                value={row.key}
                onChange={(value) => setRow(index(), "key", value)}
              />
            </div>
            <div class="flex-1">
              <TextField
                label={language.t(`${prefix()}.value`)}
                hideLabel
                type="password"
                autocomplete="off"
                placeholder={language.t(row.saved ? "marketplace.mcp.keepSaved" : `${prefix()}.value`)}
                value={row.value}
                onChange={(value) => setRow(index(), "value", value)}
              />
            </div>
            <IconButton
              type="button"
              icon="trash"
              variant="ghost"
              class="mt-1.5"
              aria-label={language.t(`${prefix()}.remove`, { key: row.key || "" })}
              onClick={() =>
                props.setForm(
                  props.field,
                  produce((rows) => {
                    rows.splice(index(), 1)
                  }),
                )
              }
            />
          </div>
        )}
      </For>
      <Show when={props.error}>
        {(error) => (
          <p role="alert" class="text-12-medium text-text-on-critical-base">
            {error()}
          </p>
        )}
      </Show>
      <Button
        type="button"
        size="small"
        variant="ghost"
        icon="plus-small"
        class="self-start"
        onClick={() =>
          props.setForm(
            props.field,
            produce((rows) => {
              rows.push(pairRow())
            }),
          )
        }
      >
        {language.t(`${prefix()}.add`)}
      </Button>
    </div>
  )
}
