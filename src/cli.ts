#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { HistoryStore, defaultDirectory } from "./history.ts"
import { formatHistory, visible } from "./format.ts"

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      directory: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  })
  if (values.help) {
    console.log("Usage: bun src/cli.ts [SESSION_ID] [--json] [--directory PATH]\nOmit SESSION_ID to list saved sessions.")
    return
  }
  if (positionals.length > 1) throw new Error("Expected at most one session ID")
  const store = new HistoryStore(resolve(values.directory ?? defaultDirectory()))
  const id = positionals[0]
  if (!id) {
    const sessions = await store.sessions()
    console.log(values.json ? JSON.stringify(sessions, null, 2) : sessions.join("\n") || "No saved sessions.")
    return
  }
  const records = await store.read(id)
  console.log(values.json ? JSON.stringify(records, null, 2) : formatHistory(records, id))
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(visible(error instanceof Error ? error.message : "Unable to read command history"))
    process.exitCode = 1
  })
}
