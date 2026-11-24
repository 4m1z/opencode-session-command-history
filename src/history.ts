import { constants } from "node:fs"
import { mkdir, open, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export type Status = "running" | "completed" | "failed" | "killed" | "timeout" | "unknown"
export interface CommandRecord {
  version: 1
  id: string
  sessionId: string
  assistantMessageId?: string
  userMessageId?: string
  userMessageText?: string
  command: string
  cwd: string
  directory: string
  workspaceId?: string
  timestamp: string
  completedAt?: string
  exitCode?: number
  status: Status
}

export function defaultDirectory(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "command-history")
}

export function sessionID(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid session ID")
  return value
}

const statuses = new Set<unknown>(["running", "completed", "failed", "killed", "timeout", "unknown"])

// Keep disk and RPC records independent of tool outputs and arbitrary event metadata.
function clean(value: unknown): CommandRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid record")
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !statuses.has(v.status)) throw new Error("Unsupported history record")
  for (const key of ["id", "command", "cwd", "directory", "timestamp"])
    if (typeof v[key] !== "string") throw new Error("Invalid history field")
  if (!Number.isFinite(Date.parse(v.timestamp as string))) throw new Error("Invalid timestamp")
  const result: CommandRecord = {
    version: 1,
    id: v.id as string,
    sessionId: sessionID(v.sessionId),
    command: v.command as string,
    cwd: v.cwd as string,
    directory: v.directory as string,
    timestamp: v.timestamp as string,
    status: v.status as Status,
  }
  for (const key of ["assistantMessageId", "userMessageId", "userMessageText", "workspaceId", "completedAt"] as const) {
    if (v[key] === undefined) continue
    if (typeof v[key] !== "string") throw new Error("Invalid history field")
    result[key] = v[key]
  }
  if (v.exitCode !== undefined) {
    if (typeof v.exitCode !== "number" || !Number.isInteger(v.exitCode)) throw new Error("Invalid exit code")
    result.exitCode = v.exitCode
  }
  return result
}

function merge(previous: CommandRecord | undefined, next: CommandRecord): CommandRecord {
  if (!previous) return next
  const terminal = previous.status !== "running" && previous.status !== "unknown"
  if (terminal && (next.status === "running" || next.status === "unknown")) return previous
  return {
    ...next, ...previous, status: next.status,
    ...(next.exitCode !== undefined ? { exitCode: next.exitCode } : {}),
    ...(next.completedAt !== undefined ? { completedAt: next.completedAt } : {}),
  }
}

export class HistoryStore {
  private cache = new Map<string, Map<string, CommandRecord>>()
  private pending = new Map<string, Promise<void>>()

  constructor(
    readonly directory: string,
    private readonly warn: (message: string) => void = console.warn,
  ) {}

  private async load(id: string): Promise<Map<string, CommandRecord>> {
    const records = new Map<string, CommandRecord>()
    let text: string
    try {
      text = await readFile(join(this.directory, `${sessionID(id)}.jsonl`), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return records
      throw error
    }
    let invalid = 0
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const record = clean(JSON.parse(line))
        if (record.sessionId !== id) throw new Error("Wrong session")
        records.set(record.id, merge(records.get(record.id), record))
      } catch {
        invalid++
      }
    }
    if (invalid) this.warn(`Command history: ignored ${invalid} invalid journal line(s) in ${id}.`)
    return records
  }

  async put(value: CommandRecord): Promise<void> {
    const record = clean(value)
    const id = record.sessionId
    const previous = this.pending.get(id) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      const records = this.cache.get(id) ?? await this.load(id)
      const before = records.get(record.id)
      const next = merge(before, record)
      if (JSON.stringify(before) === JSON.stringify(next)) return
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const file = await open(join(this.directory, `${id}.jsonl`),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try {
        // A leading newline isolates a torn last write without rewriting or deleting it.
        await file.writeFile(`\n${JSON.stringify(next)}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
      records.set(next.id, next)
      this.cache.set(id, records)
    })
    this.pending.set(id, task)
    try {
      await task
    } finally {
      if (this.pending.get(id) === task) this.pending.delete(id)
    }
  }

  async read(id: string): Promise<CommandRecord[]> {
    sessionID(id)
    await this.pending.get(id)?.catch(() => {})
    const records = await this.load(id)
    this.cache.set(id, records)
    return [...records.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
  }

  async sessions(): Promise<string[]> {
    try {
      return (await readdir(this.directory))
        .filter((file) => /^[a-zA-Z0-9_-]{1,200}\.jsonl$/.test(file))
        .map((file) => file.slice(0, -6)).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }
}
