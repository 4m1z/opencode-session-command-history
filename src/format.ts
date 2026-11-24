import type { CommandRecord } from "./history.ts"

export function visible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

export function groupHistory(records: CommandRecord[]): Map<string, CommandRecord[]> {
  const groups = new Map<string, CommandRecord[]>()
  for (const record of records) {
    const id = record.userMessageId ?? `unassociated:${record.assistantMessageId ?? "unknown"}`
    const group = groups.get(id) ?? []
    group.push(record)
    groups.set(id, group)
  }
  return groups
}

export function formatCommand(record: CommandRecord): string {
  const exit = record.exitCode === undefined ? "" : `, exit ${record.exitCode}`
  return visible([
    record.command,
    `  ${record.timestamp} | ${record.status}${exit}`,
    `  cwd: ${record.cwd}`,
    `  assistant: ${record.assistantMessageId ?? "unknown"} | shell: ${record.id}`,
    ...(record.completedAt ? [`  ended: ${record.completedAt} (observed)`] : []),
  ].join("\n"))
}

export function formatHistory(records: CommandRecord[], sessionId?: string): string {
  const lines = [`Session: ${visible(sessionId ?? records[0]?.sessionId ?? "unknown")}`]
  if (!records.length) return `${lines[0]}\n\nNo recorded commands.`
  for (const group of groupHistory(records).values()) {
    const first = group[0]!
    lines.push("", `User message: ${visible(first.userMessageId ?? "unknown (origin unavailable)")}`)
    if (first.userMessageText !== undefined) lines.push(visible(JSON.stringify(first.userMessageText)))
    lines.push(`Executed commands (${group.length}):`)
    group.forEach((record, index) => lines.push(
      `  ${index + 1}. ${formatCommand(record).replaceAll("\n", "\n     ")}`,
    ))
  }
  return lines.join("\n")
}
