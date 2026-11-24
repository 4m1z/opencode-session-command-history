import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { OpenCodeEvent, SessionMessageInfo, ShellInfo } from "@opencode/client"
import { HistoryStore } from "../src/history.ts"
import { Tracker } from "../src/tracker.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
function event(type: string, data: object, directory = "/project", created = 1795428000000): OpenCodeEvent {
  return { id: `evt_${created}`, type, created, location: { directory }, data } as OpenCodeEvent
}
function shell(id: string, sessionID = "ses_one", command = "pwd"): ShellInfo {
  return { id, command, cwd: "/project/src", shell: "/bin/sh", file: "/secret-output",
    metadata: { sessionID, secret: "DO_NOT_STORE" }, time: { started: 1795428000000 }, status: "running" }
}
async function fixture(recordPrompts = false) {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await mkdtemp("/tmp/opencode/command-history-tracker-")
  directories.push(directory)
  const store = new HistoryStore(directory)
  const contexts = new Map<string, SessionMessageInfo[]>()
  const warnings: string[] = []
  const host = {
    context: async (id: string) => contexts.get(id) ?? [],
  }
  const tracker = new Tracker(store, host, { directory: "/project", recordPrompts }, (message) => warnings.push(message))
  return { tracker, store, contexts, warnings, host }
}
async function user(tracker: Tracker, id: string, sessionID = "ses_one", text = "Inspect dependencies") {
  await tracker.handle(event("session.inbox.enqueued", {
    sessionID, inboxID: id, item: { type: "user", payload: { text }, delivery: "steer" },
  }))
  await tracker.handle(event("session.inbox.delivered", { sessionID, inboxID: id }))
}
async function step(tracker: Tracker, assistantMessageID: string, sessionID = "ses_one") {
  await tracker.handle(event("session.step.started", { sessionID, assistantMessageID, started: 1795428000000 }))
}

test("binds parallel shells to the step's delivered user, not a newly queued or steering prompt", async () => {
  const { tracker, store } = await fixture(true)
  await user(tracker, "msg_first")
  await step(tracker, "msg_assistant1")
  await user(tracker, "msg_second")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  await tracker.handle(event("shell.created", { info: shell("sh_two") }))
  await step(tracker, "msg_assistant2")
  await tracker.handle(event("shell.created", { info: shell("sh_three") }))
  await tracker.handle(event("shell.exited", { id: "sh_two", status: "exited", exit: 9 }))
  await tracker.handle(event("shell.exited", { id: "sh_one", status: "exited", exit: 0 }))
  const records = await store.read("ses_one")
  expect(records.map((r) => [r.id, r.userMessageId, r.status])).toEqual([
    ["sh_one", "msg_first", "completed"],
    ["sh_three", "msg_second", "running"],
    ["sh_two", "msg_first", "failed"],
  ])
  expect(records[0]?.userMessageText).toBe("Inspect dependencies")
  expect(JSON.stringify(records)).not.toContain("DO_NOT_STORE")
  expect(JSON.stringify(records)).not.toContain("/secret-output")
})

test("isolates simultaneous sessions and ignores other locations and untagged shell calls", async () => {
  const { tracker, store } = await fixture()
  await user(tracker, "msg_one")
  await user(tracker, "msg_other", "ses_other")
  await step(tracker, "msg_a")
  await step(tracker, "msg_b", "ses_other")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  await tracker.handle(event("shell.created", { info: shell("sh_other", "ses_other") }))
  await tracker.handle(event("shell.created", { info: shell("sh_ignored") }, "/different"))
  await tracker.handle(event("shell.created", { info: { ...shell("sh_manual"), metadata: {} } }))
  expect((await store.read("ses_one")).map((r) => r.id)).toEqual(["sh_one"])
  expect((await store.read("ses_other"))[0]?.userMessageId).toBe("msg_other")
  expect(JSON.stringify(await store.read("ses_one"))).not.toContain("Inspect dependencies")
})

test("handles exit-before-create and keeps background commands alive after the agent turn", async () => {
  const { tracker, store } = await fixture()
  await user(tracker, "msg_user")
  await step(tracker, "msg_assistant")
  await tracker.handle(event("shell.exited", { id: "sh_fast", status: "exited", exit: 0 }))
  await tracker.handle(event("shell.created", { info: shell("sh_fast") }))
  await tracker.handle(event("shell.created", { info: shell("sh_background") }))
  await tracker.handle(event("session.execution.succeeded", { sessionID: "ses_one" }))
  expect((await store.read("ses_one")).find((r) => r.id === "sh_background")?.status).toBe("running")
  await tracker.handle(event("shell.exited", { id: "sh_background", status: "timeout" }))
  await tracker.handle(event("shell.created", { info: shell("sh_fast") }))
  expect((await store.read("ses_one")).map((r) => r.status)).toEqual(["timeout", "completed"])
})

test("restart marks missing observations unknown and never guesses a new step's origin after a gap", async () => {
  const { tracker, store, host } = await fixture()
  await user(tracker, "msg_user")
  await step(tracker, "msg_assistant")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  const restarted = new Tracker(new HistoryStore(store.directory), host, { directory: "/project" })
  await restarted.recover()
  expect((await store.read("ses_one"))[0]?.status).toBe("unknown")
  await restarted.handle(event("shell.exited", { id: "sh_one", status: "killed" }))
  await step(restarted, "msg_after_compaction")
  await restarted.handle(event("shell.created", { info: shell("sh_new") }))
  const result = await new HistoryStore(store.directory).read("ses_one")
  expect(result.find((r) => r.id === "sh_one")?.status).toBe("killed")
  expect(result.find((r) => r.id === "sh_new")?.userMessageId).toBeUndefined()
})

test("resolves an existing step using its exact transcript position and fails open on disk errors", async () => {
  const { tracker, store, contexts, warnings } = await fixture()
  contexts.set("ses_one", [
    { type: "user", id: "msg_old", text: "old", time: { created: 1 } },
    { type: "assistant", id: "msg_target", time: { created: 2 }, content: [], agent: "build", model: { providerID: "test", id: "test" } },
    { type: "user", id: "msg_new", text: "new", time: { created: 3 } },
  ])
  await step(tracker, "msg_target")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  expect((await store.read("ses_one"))[0]?.userMessageId).toBe("msg_old")
  store.put = async () => { throw new Error("Disk failure with secret output") }
  await tracker.handle(event("shell.exited", { id: "sh_one", status: "killed" }))
  expect(warnings.length).toBeGreaterThan(0)
  expect(warnings.join()).not.toContain("secret output")
})

test("restoring an exact recorded step preserves its origin without copying opted-out prompt text", async () => {
  const { tracker, store, host } = await fixture(true)
  await user(tracker, "msg_old", "ses_one", "previously opted-in private prompt")
  await step(tracker, "msg_assistant")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  const restarted = new Tracker(new HistoryStore(store.directory), host, { directory: "/project", recordPrompts: false })
  await step(restarted, "msg_assistant")
  await restarted.handle(event("shell.created", { info: shell("sh_two") }))
  const restored = (await store.read("ses_one")).find((record) => record.id === "sh_two")
  expect(restored?.userMessageId).toBe("msg_old")
  expect(restored?.userMessageText).toBeUndefined()
})

test("context bootstrap retains the origin through compaction while observation remains continuous", async () => {
  const { tracker, store, contexts } = await fixture()
  contexts.set("ses_one", [
    { type: "user", id: "msg_user", text: "Inspect", time: { created: 1 } },
    { type: "assistant", id: "msg_first", time: { created: 2 }, content: [], agent: "build", model: { providerID: "test", id: "test" } },
  ])
  await step(tracker, "msg_first")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  contexts.set("ses_one", [])
  await step(tracker, "msg_after_compaction")
  await tracker.handle(event("shell.created", { info: shell("sh_two") }))
  await tracker.handle(event("session.execution.succeeded", { sessionID: "ses_one" }))
  await step(tracker, "msg_continuation")
  await tracker.handle(event("shell.created", { info: shell("sh_three") }))
  expect((await store.read("ses_one")).map((record) => record.userMessageId)).toEqual(["msg_user", "msg_user", "msg_user"])
})

test("late shell progress enriches a fast terminal record without changing its outcome or the current turn", async () => {
  const { tracker, store, contexts } = await fixture()
  contexts.set("ses_one", [
    { type: "user", id: "msg_old_user", text: "Inspect", time: { created: 1 } },
    { type: "assistant", id: "msg_old_step", time: { created: 2 }, content: [], agent: "build", model: { providerID: "test", id: "test" } },
  ])
  await tracker.handle(event("shell.exited", { id: "sh_fast", status: "exited", exit: 9 }))
  await tracker.handle(event("shell.created", { info: shell("sh_fast") }))
  await user(tracker, "msg_new_user")
  await step(tracker, "msg_new_step")
  await tracker.handle(event("session.tool.progress", {
    sessionID: "ses_one", assistantMessageID: "msg_old_step", id: "call_fast", metadata: { shellID: "sh_fast" },
  }))
  await tracker.handle(event("shell.created", { info: shell("sh_new") }))
  const records = await store.read("ses_one")
  expect(records).toHaveLength(2)
  expect(records.find((record) => record.id === "sh_fast")).toMatchObject({
    userMessageId: "msg_old_user", assistantMessageId: "msg_old_step", status: "failed", exitCode: 9,
    completedAt: "2026-11-23T10:00:00.000Z",
  })
  expect(records.find((record) => record.id === "sh_new")?.userMessageId).toBe("msg_new_user")
})

test("an unreadable journal does not block recovery or later exits in readable sessions", async () => {
  const { tracker, store, host } = await fixture()
  await user(tracker, "msg_user")
  await step(tracker, "msg_step")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  await mkdir(join(store.directory, "aaa.jsonl"))
  const warnings: string[] = []
  const restarted = new Tracker(new HistoryStore(store.directory), host, { directory: "/project" },
    (message) => warnings.push(message))
  await restarted.recover()
  expect((await store.read("ses_one"))[0]?.status).toBe("unknown")
  await restarted.handle(event("shell.exited", { id: "sh_one", status: "killed" }))
  expect((await store.read("ses_one"))[0]?.status).toBe("killed")
  expect(warnings.length).toBeGreaterThan(0)
})

test("a failed recovery write does not prevent other records from recovering or receiving exits", async () => {
  const { tracker, store, host } = await fixture()
  await user(tracker, "msg_user")
  await step(tracker, "msg_step")
  await tracker.handle(event("shell.created", { info: shell("sh_one") }))
  await tracker.handle(event("shell.created", { info: shell("sh_two") }))
  const recovering = new HistoryStore(store.directory)
  const put = recovering.put.bind(recovering)
  recovering.put = async (record) => {
    if (record.id === "sh_one" && record.status === "unknown") throw new Error("Write failed")
    await put(record)
  }
  const warnings: string[] = []
  const restarted = new Tracker(recovering, host, { directory: "/project" }, (message) => warnings.push(message))
  await restarted.recover()
  expect((await store.read("ses_one")).find((record) => record.id === "sh_two")?.status).toBe("unknown")
  await restarted.handle(event("shell.exited", { id: "sh_one", status: "exited", exit: 0 }))
  await restarted.handle(event("shell.exited", { id: "sh_two", status: "exited", exit: 3 }))
  expect((await store.read("ses_one")).map((record) => record.status)).toEqual(["completed", "failed"])
  expect(warnings.length).toBeGreaterThan(0)
})

test.each(["mid-step", "same-step", "newer-step"] as const)(
  "progress bootstrap survives compaction without replacing a newer step (%s)",
  async (observed) => {
    const { tracker, store, contexts } = await fixture()
    if (observed === "same-step") await step(tracker, "msg_original")
    await tracker.handle(event("shell.created", { info: shell("sh_first") }))
    if (observed === "newer-step") {
      await step(tracker, "msg_newer")
      await tracker.handle(event("session.execution.succeeded", { sessionID: "ses_one" }))
    }
    contexts.set("ses_one", [
      { type: "user", id: "msg_user", text: "Inspect", time: { created: 1 } },
      { type: "assistant", id: "msg_original", time: { created: 2 }, content: [], agent: "build", model: { providerID: "test", id: "test" } },
    ])
    await tracker.handle(event("session.tool.progress", {
      sessionID: "ses_one", assistantMessageID: "msg_original", id: "call_first", metadata: { shellID: "sh_first" },
    }))
    contexts.set("ses_one", [])
    await step(tracker, "msg_after_compaction")
    await tracker.handle(event("shell.created", { info: shell("sh_next") }))
    const records = await store.read("ses_one")
    expect(records.find((record) => record.id === "sh_first")?.userMessageId).toBe("msg_user")
    expect(records.find((record) => record.id === "sh_next")?.userMessageId)
      .toBe(observed === "newer-step" ? undefined : "msg_user")
  },
)

test("a session returning from another location resolves its new user instead of a retained origin", async () => {
  const { tracker, store, contexts } = await fixture()
  await user(tracker, "msg_before_move")
  await step(tracker, "msg_before_step")
  await tracker.handle(event("shell.created", { info: shell("sh_before") }))
  await tracker.handle(event("session.execution.succeeded", { sessionID: "ses_one" }))
  await tracker.handle(event("session.moved", {
    sessionID: "ses_one", location: { directory: "/other" }, projectID: "proj_other",
  }, "/other"))
  await tracker.handle(event("session.inbox.enqueued", {
    sessionID: "ses_one", inboxID: "msg_while_away",
    item: { type: "user", payload: { text: "Continue elsewhere" }, delivery: "steer" },
  }, "/other"))
  await tracker.handle(event("session.inbox.delivered", {
    sessionID: "ses_one", inboxID: "msg_while_away",
  }, "/other"))
  await tracker.handle(event("session.moved", {
    sessionID: "ses_one", location: { directory: "/project" }, projectID: "proj_home",
  }, "/other"))
  contexts.set("ses_one", [
    { type: "user", id: "msg_while_away", text: "Continue elsewhere", time: { created: 3 } },
    { type: "assistant", id: "msg_return_step", time: { created: 4 }, content: [], agent: "build", model: { providerID: "test", id: "test" } },
  ])
  await step(tracker, "msg_return_step")
  await tracker.handle(event("shell.created", { info: shell("sh_return") }))
  expect((await store.read("ses_one")).map((record) => record.userMessageId))
    .toEqual(["msg_before_move", "msg_while_away"])
})
