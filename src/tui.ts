import { Plugin } from "@opencode/plugin/tui"
import { CommandHistory, type HistoryView } from "./rpc.ts"

export default Plugin.define({
  id: "command-history.tui",
  setup(ctx) {
    const history = ctx.client.rpc(CommandHistory)
    const counts = new Map<string, Set<string>>()
    async function show() {
      const route = ctx.ui.router.current()
      if (route.type !== "session") {
        ctx.ui.toast.show({ message: "Open a session to view its command history.", variant: "info" })
        return
      }
      try {
        const session = ctx.data.session.get(route.sessionID)
        const location = session?.location ?? ctx.location ?? ctx.data.location.default()
        const view = await history.history({ sessionID: route.sessionID }, { location }) as HistoryView
        if (view.warning) ctx.ui.toast.show({ message: view.warning, variant: "warning", duration: 8000 })
        if (!view.count) {
          await ctx.ui.dialog.alert({ title: "Command history", message: view.text })
          return
        }
        const selected = await ctx.ui.dialog.select({
          title: `Command history (${view.count})`,
          placeholder: "Search commands or user messages…",
          options: view.items,
          search: (query, items) => items.filter((item) =>
            `${item.title} ${item.category} ${item.description}`.toLowerCase().includes(query.toLowerCase())),
        })
        const item = view.items.find((item) => item.value === selected)
        if (item) await ctx.ui.dialog.alert({ title: "Command details", message: item.detail })
      } catch {
        ctx.ui.toast.show({ title: "Command history", message: "Could not read history. Check the server plugin and storage permissions.", variant: "error" })
      }
    }
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "command-history.show",
        title: "Show command history",
        group: "Session",
        palette: true,
        slash: { name: "command-history" },
        run: show,
      }],
    }))
    const offShell = ctx.data.on("shell.created", (event) => {
      const id = event.data.info.metadata.sessionID
      if (typeof id !== "string") return
      const shells = counts.get(id) ?? new Set<string>()
      shells.add(event.data.info.id)
      counts.set(id, shells)
    })
    const offDone = ctx.data.on("session.execution.succeeded", (event) => {
      const id = event.data.sessionID
      const count = counts.get(id)?.size ?? 0
      counts.delete(id)
      if (!count) return
      const route = ctx.ui.router.current()
      if (route.type !== "session" || route.sessionID !== id) return
      if (ctx.options.autoShow === true) void show()
      else if (ctx.options.notifyOnTurn !== false)
        ctx.ui.toast.show({ title: "Command history", message: `${count} shell command${count === 1 ? "" : "s"} ran. View /command-history.`, variant: "info" })
    })
    const offFailed = ctx.data.on("session.execution.failed", (event) => { counts.delete(event.data.sessionID) })
    const offInterrupted = ctx.data.on("session.execution.interrupted", (event) => { counts.delete(event.data.sessionID) })
    return () => { offShell(); offDone(); offFailed(); offInterrupted() }
  },
})
