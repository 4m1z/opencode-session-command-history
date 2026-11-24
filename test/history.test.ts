import { afterEach, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { HistoryStore, type CommandRecord } from "../src/history.ts"
import { formatHistory } from "../src/format.ts"

const directories: string[] = []
async function store() {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await mkdtemp("/tmp/opencode/command-history-unit-")
  directories.push(directory)
  return new HistoryStore(join(directory, "history"))
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

export function record(overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    version: 1,
    sessionId: "ses_one",
    id: "sh_one",
    assistantMessageId: "msg_assistant",
    userMessageId: "msg_user",
    command: "pwd",
    cwd: "/project",
    directory: "/project",
    timestamp: "2026-11-23T10:00:00.000Z",
    status: "running",
    ...overrides,
  }
}

test("persists isolated sessions and deduplicates identities, not identical commands", async () => {
  const history = await store()
  await Promise.all([
    history.put(record()),
    history.put(record()),
    history.put(record({ id: "sh_two", timestamp: "2026-11-23T09:59:59.000Z" })),
    history.put(record({ sessionId: "ses_two" })),
  ])
  await history.put(record({ status: "completed", exitCode: 0, completedAt: "2026-11-23T10:00:01.000Z" }))
  await history.put(record())
  const reopened = new HistoryStore(history.directory)
  const first = await reopened.read("ses_one")
  expect(first.map((item) => item.id)).toEqual(["sh_two", "sh_one"])
  expect(first[1]?.status).toBe("completed")
  expect(first[1]?.exitCode).toBe(0)
  expect(await reopened.read("ses_two")).toHaveLength(1)
  expect(await reopened.sessions()).toEqual(["ses_one", "ses_two"])
  const lines = (await readFile(join(history.directory, "ses_one.jsonl"), "utf8")).trim().split("\n").filter(Boolean)
  expect(lines).toHaveLength(3)
})

test("keeps valid history around a partial write and reports corruption", async () => {
  const history = await store()
  await history.put(record())
  await appendFile(join(history.directory, "ses_one.jsonl"), '{"version":')
  const warnings: string[] = []
  const reopened = new HistoryStore(history.directory, (message) => warnings.push(message))
  expect(await reopened.read("ses_one")).toHaveLength(1)
  await reopened.put(record({ id: "sh_two" }))
  expect(await new HistoryStore(history.directory, () => {}).read("ses_one")).toHaveLength(2)
  expect(warnings.length).toBeGreaterThan(0)
})

test("rejects path traversal and strips fields outside the persistence allowlist", async () => {
  const history = await store()
  await expect(history.put(record({ sessionId: "../private" }))).rejects.toThrow("Invalid session ID")
  await expect(history.read("../private")).rejects.toThrow("Invalid session ID")
  await history.put({ ...record(), output: "secret-output", env: { TOKEN: "secret-env" } } as CommandRecord)
  const text = await readFile(join(history.directory, "ses_one.jsonl"), "utf8")
  expect(text).not.toContain("secret")
  expect((await stat(history.directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(history.directory, "ses_one.jsonl"))).mode & 0o777).toBe(0o600)
})

test("groups by user message and makes terminal escapes visible", () => {
  const text = formatHistory([
    record({ command: "printf '\\n'\nls\u001b[2J", userMessageText: "Inspect files" }),
    record({ id: "sh_two", userMessageId: "msg_next", status: "failed", exitCode: 7 }),
  ])
  expect(text).toContain('User message: msg_user\n"Inspect files"')
  expect(text).toContain("User message: msg_next")
  expect(text).toContain("exit 7")
  expect(text).toContain("\\u001b[2J")
  expect(text).not.toContain("\u001b")
})

test("replayed lifecycle events cannot move a command to a later user turn", async () => {
  const history = await store()
  await history.put(record({ status: "completed", exitCode: 0 }))
  await history.put(record({ status: "completed", exitCode: 0, userMessageId: "msg_later", assistantMessageId: "msg_later_assistant" }))
  expect((await history.read("ses_one"))[0]?.userMessageId).toBe("msg_user")
})
