import { expect, test } from "bun:test"
import type { Context, KeymapCommand, KeymapLayer } from "@opencode/plugin/tui/context"
import type { OpenCodeEvent } from "@opencode/client"
import plugin from "../src/tui.ts"

test("slash command reads the selected session at its location and displays details without prompting the agent", async () => {
  let command: KeymapCommand | undefined
  const alerts: object[] = []
  const calls: unknown[] = []
  const context = {
    options: {},
    location: { directory: "/project" },
    client: { rpc: () => ({ history: async (...args: unknown[]) => {
      calls.push(args)
      return { count: 1, text: "Session: ses_selected\npwd", items: [
        { value: "sh_one", title: "pwd", category: "msg_user", description: "completed", detail: "cwd: /project\npwd" },
      ] }
    } }) },
    keymap: { layer: (factory: () => KeymapLayer) => { command = factory().commands?.[0] } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_selected" }) },
      dialog: {
        select: async () => "sh_one",
        alert: async (input: object) => { alerts.push(input) },
      },
      toast: { show() {} },
    },
    data: { on: () => () => {}, session: { get: () => ({ location: { directory: "/project" } }) }, location: { default: () => ({ directory: "/project" }) } },
  } as unknown as Context
  const cleanup = await plugin.setup(context)
  expect(command?.slash?.name).toBe("command-history")
  await command!.run()
  expect(calls).toEqual([[{ sessionID: "ses_selected" }, { location: { directory: "/project" } }]])
  expect(alerts).toEqual([{ title: "Command details", message: "cwd: /project\npwd" }])
  await cleanup?.()
})

test.each(["session.execution.failed", "session.execution.interrupted"])(
  "clears pending notification and auto-show counts on %s",
  async (terminalEvent) => {
    for (const autoShow of [false, true]) {
      const handlers = new Map<string, (event: OpenCodeEvent) => void>()
      const toasts: object[] = []
      let views = 0
      const context = {
        options: { autoShow },
        location: { directory: "/project" },
        client: { rpc: () => ({ history: async () => {
          views++
          return { count: 0, text: "No commands", items: [] }
        } }) },
        keymap: { layer() {} },
        ui: {
          router: { current: () => ({ type: "session", sessionID: "ses_selected" }) },
          toast: { show: (toast: object) => { toasts.push(toast) } },
          dialog: { alert: async () => {} },
        },
        data: {
          on: (type: string, handler: (event: OpenCodeEvent) => void) => {
            handlers.set(type, handler)
            return () => { handlers.delete(type) }
          },
          session: { get: () => ({ location: { directory: "/project" } }) },
        },
      } as unknown as Context
      const emit = (type: string, data: object) => handlers.get(type)?.({
        type, data, id: "evt_test", created: 1, location: { directory: "/project" },
      } as OpenCodeEvent)
      const started = () => emit("shell.created", { info: {
        id: "sh_one", command: "pwd", cwd: "/project", shell: "/bin/sh", file: "/output",
        status: "running", time: { started: 1 }, metadata: { sessionID: "ses_selected" },
      } })
      const cleanup = await plugin.setup(context)
      started()
      emit(terminalEvent, { sessionID: "ses_selected" })
      emit("session.execution.succeeded", { sessionID: "ses_selected" })
      await Promise.resolve()
      expect(toasts).toHaveLength(0)
      expect(views).toBe(0)
      started()
      emit("session.execution.succeeded", { sessionID: "ses_selected" })
      await Promise.resolve()
      expect(autoShow ? views : toasts.length).toBe(1)
      await cleanup?.()
      expect(handlers.size).toBe(0)
    }
  },
)
