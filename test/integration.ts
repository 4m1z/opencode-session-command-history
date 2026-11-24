import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { OpenCode, type OpenCodeEvent } from "@opencode/client"
import { CommandHistory, type HistoryView } from "../src/rpc.ts"
import { HistoryStore } from "../src/history.ts"
import { verifyTerminal } from "./terminal.ts"

// Real OpenCode + real shell tools; only the paid inference service is replaced.
await mkdir("/tmp/opencode", { recursive: true })
const root = await mkdtemp("/tmp/opencode/command-history-integration-")
const project = join(root, "project")
await mkdir(join(project, "src"), { recursive: true })
await writeFile(join(project, "package.json"), '{"name":"validation-fixture","dependencies":{"example":"1.0.0"}}\n')
await writeFile(join(project, "src", "index.ts"), "export const example = true\n")
for (const dir of ["home", "config/opencode", "data", "state", "cache", "runtime"])
  await mkdir(join(root, dir), { recursive: true, mode: 0o700 })

const cases: Record<string, { command: string; workdir?: string; background?: boolean; timeout?: number }[]> = {
  FIRST: [{ command: "pwd" }, { command: "ls -la" }, { command: "cat package.json" }, { command: "find src -type f" }],
  SECOND: [{ command: "printf second" }, { command: "exit 7", workdir: join(project, "src") }],
  OTHER: [{ command: "printf other-session" }],
  AWAY: [{ command: "printf away-session" }],
  RETURN: [{ command: "printf returned-session" }],
  BACKGROUND: [{ command: "sleep 0.2", background: true }],
  CANCEL: [{ command: "sleep 30" }],
  TIMEOUT: [{ command: "sleep 30", background: true, timeout: 100 }],
}
const requests: string[] = []
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json() as {
      stream?: boolean
      messages: { role: string; content: unknown }[]
      tools?: { function: { name: string } }[]
    }
    const texts = body.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    const index = texts.findLastIndex((text, i) => body.messages[i]?.role === "user" && /CASE:\w+/.test(text))
    const name = index === -1 ? undefined : [...texts[index]!.matchAll(/CASE:(\w+)/g)].at(-1)?.[1]
    const done = index !== -1 && body.messages.slice(index + 1).some((message) => message.role === "tool")
    const shell = body.tools?.find((tool) => tool.function.name === "shell")?.function.name
    requests.push(JSON.stringify({ name, done, tools: body.tools?.map((t) => t.function.name) }))
    const commands = name && shell && !done ? cases[name] ?? [] : []
    const calls = commands.map((input, i) => ({
      index: i, id: `call_${name}_${i}`, type: "function",
      function: { name: shell!, arguments: JSON.stringify(input) },
    }))
    const message = calls.length ? { role: "assistant", tool_calls: calls } : { role: "assistant", content: "Validation completed." }
    const finish = calls.length ? "tool_calls" : "stop"
    const base = { id: `chatcmpl_${randomBytes(6).toString("hex")}`, created: Math.floor(Date.now() / 1000), model: "fixture" }
    if (!body.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }] })
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(chunk(message, null) + chunk({}, finish) + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const password = randomBytes(24).toString("hex")
const env = {
  PATH: process.env.PATH!,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  OPENCODE_PASSWORD: password,
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  HISTORY_TEST_KEY: "local-fixture-only",
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
}
await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({
  update: "disable",
  plugins: [{ package: resolve(process.env.HISTORY_PLUGIN_PATH ?? "."), options: { directory: join(root, "history"), recordPrompts: true } }],
  model: "history-fixture/fixture",
  shell: "/bin/sh",
  snapshots: false,
  permissions: [{ action: "*", resource: "*", effect: "allow" }],
  providers: { "history-fixture": {
    env: ["HISTORY_TEST_KEY"],
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `${model.url}v1` },
    models: { fixture: { capabilities: { tools: true }, limit: { context: 64000, output: 4096 } } },
  } },
}))
let server: ReturnType<typeof Bun.spawn> | undefined
let logs = ""
async function start() {
  const child = Bun.spawn([Bun.which("opencode")!, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  server = child
  void new Response(child.stderr).text().then((text) => { logs += text })
  const reader = child.stdout.getReader()
  let text = ""
  const timeout = setTimeout(() => child.kill(), 30_000)
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) throw new Error(`Server stopped before readiness: ${text}\n${logs}`)
      text += new TextDecoder().decode(next.value)
      const match = /"url"\s*:\s*"(http:[^"]+)"/.exec(text)
      if (match) {
        const client = OpenCode.make({
          baseUrl: match[1]!,
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        })
        return { client, url: match[1]! }
      }
    }
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
}
async function stop() {
  if (!server) return
  server.kill("SIGTERM")
  await server.exited
  server = undefined
}
try {
  let { client, url } = await start()
  const location = { directory: project }
  const a = await client.session.create({ location, title: "Command history demo" })
  const b = await client.session.create({ location, title: "Concurrent session" })
  const first = await client.session.prompt({ sessionID: a.id, text: "CASE:FIRST Please inspect my project and identify dependencies." })
  const other = await client.session.prompt({ sessionID: b.id, text: "CASE:OTHER Inspect the other session." })
  await Promise.all([client.session.wait({ sessionID: a.id }), client.session.wait({ sessionID: b.id })])
  const plugins = await client.plugin.list({ location })
  assert(plugins.data.some((plugin) => plugin.id === "command-history"), `plugin must load: ${JSON.stringify(plugins.data)}`)
  const second = await client.session.prompt({ sessionID: a.id, text: "CASE:SECOND Run a second check, including a failing command." })
  await client.session.wait({ sessionID: a.id })
  let view = await client.rpc(CommandHistory).history({ sessionID: a.id }, { location }) as HistoryView
  assert.equal(view.count, 6, `first two turns: ${JSON.stringify(view)}\nrequests: ${requests.join("\n")}`)
  const store = new HistoryStore(join(root, "history"))
  let records = await store.read(a.id)
  assert.equal(records.filter((record) => record.userMessageId === first.id).length, 4)
  assert.equal(records.filter((record) => record.userMessageId === second.id).length, 2)
  assert(records.every((record) => record.assistantMessageId))
  assert.equal(records.find((record) => record.command === "exit 7")?.exitCode, 7)
  assert.equal(records.find((record) => record.command === "exit 7")?.cwd, join(project, "src"))
  assert.equal((await store.read(b.id))[0]?.userMessageId, other.id)
  await writeFile(join(root, "sample-history.txt"), view.text + "\n")
  console.log("PASS: real tool capture, two turns, parallel tools, two sessions, cwd, exit codes and RPC.")

  const away = { directory: join(root, "other-project") }
  await mkdir(away.directory)
  await client.session.move({ sessionID: b.id, directory: away.directory })
  await client.session.wait({ sessionID: b.id })
  const movedUser = await client.session.prompt({ sessionID: b.id, text: "CASE:AWAY Run a check in the new directory." })
  await client.session.wait({ sessionID: b.id })
  await client.rpc(CommandHistory).history({ sessionID: b.id }, { location: away })
  await client.session.move({ sessionID: b.id, directory: project })
  await client.session.wait({ sessionID: b.id })
  await client.session.synthetic({ sessionID: b.id, text: "CASE:RETURN Continue the same user request after moving back." })
  await client.session.wait({ sessionID: b.id })
  await client.rpc(CommandHistory).history({ sessionID: b.id }, { location })
  const movedRecords = await store.read(b.id)
  assert.equal(movedRecords.length, 3, `moved-session records: ${JSON.stringify(movedRecords)}\nrequests: ${requests.join("\n")}`)
  assert.equal(movedRecords.find((record) => record.command === "printf away-session")?.directory, away.directory)
  assert.equal(movedRecords.find((record) => record.command === "printf returned-session")?.directory, project)
  assert.equal(movedRecords.find((record) => record.command === "printf returned-session")?.userMessageId, movedUser.id)
  console.log("PASS: session moves away and back retain the correct user on synthetic continuation.")

  // Observe lifecycle events directly instead of polling the history or process.
  const abort = new AbortController()
  const waiters: { predicate: (event: OpenCodeEvent) => boolean; resolve: (event: OpenCodeEvent) => void }[] = []
  const stream = (async () => {
    for await (const event of client.event.subscribe({ signal: abort.signal })) {
      for (const waiter of [...waiters]) if (waiter.predicate(event)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(event)
      }
    }
  })().catch(() => {})
  const on = (predicate: (event: OpenCodeEvent) => boolean) => new Promise<OpenCodeEvent>((resolve) => {
    waiters.push({ predicate, resolve })
  })
  await on((event) => event.type === "server.connected")
  for (const name of ["BACKGROUND", "TIMEOUT", "CANCEL"]) {
    const started = on((event) => event.type === "shell.created" && event.data.info.metadata.sessionID === a.id)
    const exited = on((event) => event.type === "shell.exited")
    await client.session.prompt({ sessionID: a.id, text: `CASE:${name} Test process lifecycle.` })
    await started
    if (name === "CANCEL") await client.session.interrupt({ sessionID: a.id, resume: false })
    await exited
    await client.session.wait({ sessionID: a.id })
  }
  await client.rpc(CommandHistory).history({ sessionID: a.id }, { location })
  records = await store.read(a.id)
  assert(records.some((record) => record.status === "timeout"))
  assert(records.some((record) => record.status === "killed"))
  assert.equal(records.filter((record) => record.command === "sleep 0.2")[0]?.status, "completed")
  abort.abort()
  await stream
  console.log("PASS: background completion, timeout and user cancellation.")

  await stop()
  ;({ client, url } = await start())
  // Prompt admission waits for location plugins to activate after a cold start.
  await client.session.prompt({ sessionID: a.id, text: "CASE:READ_ONLY Verify the saved history without tools." })
  await client.session.wait({ sessionID: a.id })
  view = await client.rpc(CommandHistory).history({ sessionID: a.id }, { location }) as HistoryView
  assert.equal(view.count, 9)
  assert.equal((await new HistoryStore(store.directory).read(a.id)).length, 9)
  console.log("PASS: history survives an actual server restart.")
  if (process.platform === "linux" || process.platform === "darwin")
    await verifyTerminal({ url, sessionID: a.id, project, env, root })
  console.log(`Sample output: ${root}/sample-history.txt`)
  await writeFile(join(root, "validation.json"), JSON.stringify({ root, project, sessionID: a.id, url }, null, 2))
  if (process.env.HISTORY_TEST_TUI === "1") {
    // Interactive check shares only this disposable server and isolated config.
    const tui = Bun.spawn([Bun.which("opencode")!, "--server", url, "--session", a.id, project],
      { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    await tui.exited
  }
} finally {
  await stop()
  model.stop(true)
  await writeFile(join(root, "server.log"), logs)
  console.log(`Validation artifacts: ${root}`)
}
