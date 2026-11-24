import type { OpenCodeEvent, SessionMessageInfo, ShellInfo } from "@opencode/client"
import { HistoryStore, type CommandRecord } from "./history.ts"

export interface Origin { id: string; text?: string }
interface Host {
  context(sessionId: string): Promise<readonly SessionMessageInfo[]>
}
interface Options { directory: string; workspaceId?: string; recordPrompts?: boolean }
type Exit = Extract<OpenCodeEvent, { type: "shell.exited" }>
const terminalEvents = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

export const eventTypes = [
  "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled", "session.step.started",
  "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.tool.progress", "session.moved", "session.deleted", "shell.created", "shell.exited",
] as const

export class Tracker {
  private users = new Map<string, Origin | undefined>()
  private pending = new Map<string, Origin>()
  private steps = new Map<string, { id: string; origin?: Origin }>()
  private shells = new Map<string, CommandRecord>()
  private earlyExits = new Map<string, Exit>()
  warning?: string

  constructor(
    readonly store: HistoryStore,
    private readonly host: Host,
    private readonly options: Options,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  report(message: string) {
    this.warning = message
    this.warn(message)
  }

  private owns(record: { directory: string; workspaceId?: string }): boolean {
    return record.directory === this.options.directory && record.workspaceId === this.options.workspaceId
  }

  private origin(id: string, text?: string): Origin {
    return { id, ...(this.options.recordPrompts && text !== undefined ? { text } : {}) }
  }

  private async resolveOrigin(sessionId: string, assistantId: string): Promise<Origin | undefined> {
    // Active context is sufficient at activation; delivered events preserve ancestry across later compactions.
    const messages = await this.host.context(sessionId)
    const index = messages.findIndex((message) => message.id === assistantId)
    if (index !== -1) {
      for (let i = index - 1; i >= 0; i--) {
        const message = messages[i]!
        if (message.type === "user") return this.origin(message.id, message.text)
      }
    }
    // A saved latest user cannot prove ancestry after an observation gap; an exact step match can.
    const saved = (await this.store.read(sessionId)).find((record) =>
      record.assistantMessageId === assistantId && record.userMessageId !== undefined)
    return saved?.userMessageId ? this.origin(saved.userMessageId, saved.userMessageText) : undefined
  }

  async recover(): Promise<void> {
    let sessions: string[]
    try {
      sessions = await this.store.sessions()
    } catch {
      this.report("Command history: recovery failed; history may be incomplete.")
      return
    }
    for (const id of sessions) {
      let records: CommandRecord[]
      try {
        records = await this.store.read(id)
      } catch {
        this.report(`Command history: could not recover journal ${id}; continuing with other sessions.`)
        continue
      }
      for (const record of records) {
        if (!this.owns(record) || (record.status !== "running" && record.status !== "unknown")) continue
        const unknown: CommandRecord = { ...record, status: "unknown" }
        this.shells.set(record.id, unknown)
        try {
          await this.store.put(unknown)
        } catch {
          this.report(`Command history: could not update a recovered command in ${id}; continuing recovery.`)
        }
      }
    }
  }

  private async created(info: ShellInfo) {
    const sessionId = info.metadata.sessionID
    if (typeof sessionId !== "string") return
    const step = this.steps.get(sessionId)
    const record: CommandRecord = this.shells.get(info.id) ?? {
      version: 1,
      id: info.id,
      sessionId,
      ...(step ? { assistantMessageId: step.id } : {}),
      ...(step?.origin ? { userMessageId: step.origin.id } : {}),
      ...(step?.origin?.text !== undefined ? { userMessageText: step.origin.text } : {}),
      command: info.command,
      cwd: info.cwd,
      directory: this.options.directory,
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      timestamp: new Date(info.time.started).toISOString(),
      status: "running",
    }
    this.shells.set(info.id, record)
    await this.store.put(record)
    const exit = this.earlyExits.get(info.id)
    if (exit) {
      this.earlyExits.delete(info.id)
      await this.exited(exit)
    }
  }

  private async exited(event: Exit) {
    const { id, exit, status } = event.data
    const record = this.shells.get(id)
    if (!record) {
      this.earlyExits.set(id, event)
      // Shell events also include unrelated processes; do not retain their exits indefinitely.
      if (this.earlyExits.size > 512) this.earlyExits.delete(this.earlyExits.keys().next().value!)
      return
    }
    if (status === "running") return
    const completed: CommandRecord = {
      ...record,
      status: status === "exited" ? (exit === undefined ? "unknown" : exit === 0 ? "completed" : "failed") : status,
      completedAt: new Date(event.created).toISOString(),
      ...(exit !== undefined ? { exitCode: exit } : {}),
    }
    await this.store.put(completed)
    this.shells.delete(id)
  }

  async handle(event: OpenCodeEvent): Promise<void> {
    // Moves may be published outside this location, but still break attribution continuity here.
    if (event.type === "session.moved" || event.type === "session.deleted") {
      this.steps.delete(event.data.sessionID)
      this.users.delete(event.data.sessionID)
      for (const key of this.pending.keys())
        if (key.startsWith(`${event.data.sessionID}/`)) this.pending.delete(key)
      return
    }
    if (event.location?.directory !== this.options.directory ||
        ("workspaceID" in event.location ? event.location.workspaceID : undefined) !== this.options.workspaceId) return
    try {
      if (event.type === "session.inbox.enqueued") {
        if (event.data.item.type === "user")
          this.pending.set(`${event.data.sessionID}/${event.data.inboxID}`,
            this.origin(event.data.inboxID, event.data.item.payload.text))
      } else if (event.type === "session.inbox.cancelled") {
        this.pending.delete(`${event.data.sessionID}/${event.data.inboxID}`)
      } else if (event.type === "session.inbox.delivered") {
        const { sessionID, inboxID } = event.data
        const key = `${sessionID}/${inboxID}`
        let origin = this.pending.get(key)
        this.pending.delete(key)
        if (!origin) {
          const message = (await this.host.context(sessionID)).find((item) => item.id === inboxID)
          if (message?.type === "user") origin = this.origin(message.id, message.text)
        }
        if (origin) {
          this.users.set(sessionID, origin)
        }
      } else if (event.type === "session.step.started") {
        const { sessionID, assistantMessageID } = event.data
        const origin = this.users.get(sessionID) ?? await this.resolveOrigin(sessionID, assistantMessageID)
        // Remember unresolved steps too, so late progress cannot bootstrap an older turn.
        this.users.set(sessionID, origin)
        this.steps.set(sessionID, { id: assistantMessageID, origin })
      } else if (event.type === "shell.created") {
        await this.created(event.data.info)
      } else if (event.type === "shell.exited") {
        await this.exited(event)
      } else if (event.type === "session.tool.progress") {
        const { sessionID, assistantMessageID, metadata } = event.data
        if (typeof metadata.shellID !== "string") return
        const record = this.shells.get(metadata.shellID) ??
          (await this.store.read(sessionID)).find((record) => record.id === metadata.shellID)
        if (record && record.sessionId === sessionID &&
            (!record.assistantMessageId || record.assistantMessageId === assistantMessageID) &&
            (!record.assistantMessageId || !record.userMessageId)) {
          const origin = await this.resolveOrigin(sessionID, assistantMessageID)
          const step = this.steps.get(sessionID)
          if (origin && !this.users.get(sessionID) &&
              (!this.users.has(sessionID) || step?.id === assistantMessageID))
            this.users.set(sessionID, origin)
          if (origin && step?.id === assistantMessageID && !step.origin) step.origin = origin
          const linked = { ...record, assistantMessageId: assistantMessageID, ...(origin ? { userMessageId: origin.id } : {}),
            ...(origin?.text !== undefined ? { userMessageText: origin.text } : {}) }
          if (this.shells.has(record.id)) this.shells.set(record.id, linked)
          await this.store.put(linked)
        }
      } else if (terminalEvents.has(event.type) && "sessionID" in event.data) {
        this.steps.delete(event.data.sessionID as string)
      }
    } catch {
      this.report(`Command history: could not record ${event.type}; history may be incomplete.`)
    }
  }
}
