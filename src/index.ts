import { Plugin } from "@opencode/plugin"
import { isAbsolute, resolve } from "node:path"
import { HistoryStore, defaultDirectory, sessionID } from "./history.ts"
import { formatHistory, groupHistory, visible } from "./format.ts"
import { CommandHistory, type HistoryView } from "./rpc.ts"
import { Tracker, eventTypes } from "./tracker.ts"

export default Plugin.define({
  id: "command-history",
  async setup(ctx) {
    const options = ctx.options
    if (options.directory !== undefined && (typeof options.directory !== "string" || !isAbsolute(options.directory)))
      throw new Error("command-history: directory must be an absolute path")
    for (const key of ["recordPrompts", "notifyOnTurn", "autoShow"])
      if (options[key] !== undefined && typeof options[key] !== "boolean")
        throw new Error(`command-history: ${key} must be boolean`)

    const directory = resolve(options.directory as string ?? defaultDirectory())
    let warning: string | undefined
    const warn = (message: string) => { warning = message; console.warn(message) }
    const store = new HistoryStore(directory, warn)
    const tracker = new Tracker(store, {
      context: (sessionId) => ctx.session.context({ sessionID: sessionId }),
    }, {
      directory: ctx.location.directory,
      workspaceId: ctx.location.workspaceID,
      recordPrompts: options.recordPrompts === true,
    }, warn)

    const controller = new AbortController()
    // Subscribe before recovery so exits during disk reads are queued, not lost.
    const events = ctx.event.subscribe({ types: [...eventTypes], signal: controller.signal })
    const recovered = tracker.recover()
    let processing: Promise<void> = recovered
    const consume = (async () => {
      for await (const event of events) {
        processing = processing.then(() => tracker.handle(event))
      }
    })().catch(() => {
      if (!controller.signal.aborted) warn("Command history: event stream stopped; reload the plugin to resume capture.")
    })

    await ctx.rpc.register(CommandHistory, {
      history: async (input): Promise<HistoryView> => {
        const id = sessionID((input as { sessionID: string }).sessionID)
        await ctx.session.get({ sessionID: id })
        await processing
        const records = await store.read(id)
        // Prompt text is fetched only for display unless explicitly opted into persistence.
        const context = await ctx.session.context({ sessionID: id })
        const prompts = new Map(context.filter((m) => m.type === "user").map((m) => [m.id, m.text]))
        const display = records.map((record) => {
          const text = record.userMessageId ? prompts.get(record.userMessageId) : undefined
          return text === undefined ? record : { ...record, userMessageText: text }
        })
        return {
          count: display.length,
          text: formatHistory(display, id),
          ...(warning ? { warning } : {}),
          items: [...groupHistory(display).values()].flatMap((group, index) => group.map((record) => ({
            value: record.id,
            title: visible(record.command).replaceAll("\n", " ↵ "),
            category: visible(`Message ${index + 1}: ${record.userMessageId ?? "unknown origin"}${record.userMessageText ? ` — ${record.userMessageText.replaceAll("\n", " ").slice(0, 100)}` : ""}`),
            description: visible(`${record.timestamp} · ${record.status}${record.exitCode === undefined ? "" : ` · exit ${record.exitCode}`}`),
            detail: formatHistory([record], id),
          }))),
        }
      },
    })
    return async () => {
      controller.abort()
      await consume
      await processing
    }
  },
})
