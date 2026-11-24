import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { stripVTControlCharacters } from "node:util"

export async function verifyTerminal(input: {
  url: string
  sessionID: string
  project: string
  env: Record<string, string>
  root: string
}) {
  let output = ""
  let wake: (() => void) | undefined
  const terminal = new Bun.Terminal({
    cols: 120, rows: 40,
    data(term, bytes) {
      const text = new TextDecoder().decode(bytes)
      output += stripVTControlCharacters(text)
      // Basic terminal capability replies, as a terminal emulator would provide.
      if (text.includes("\x1b[6n")) term.write("\x1b[1;1R")
      if (text.includes("\x1b[c")) term.write("\x1b[?1;2c")
      wake?.()
    },
  })
  const child = Bun.spawn([Bun.which("opencode")!, "--server", input.url, "--session", input.sessionID, input.project], {
    env: input.env, cwd: input.project, terminal,
  })
  const waitFor = async (text: string) => {
    const started = Date.now()
    while (!output.includes(text)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`TUI did not display ${JSON.stringify(text)}:\n${output.slice(-3000)}`)),
          Math.max(1, 20_000 - (Date.now() - started)))
        wake = () => { clearTimeout(timer); resolve() }
      })
    }
    wake = undefined
  }
  try {
    await waitFor("Command history demo")
    output = ""
    terminal.write("/command-history")
    await waitFor("Show command history")
    output = ""
    terminal.write("\r")
    await waitFor("Command history (9)")
    await waitFor("Message 1")
    output = ""
    terminal.write("exit 7")
    await waitFor("exit 7")
    output = ""
    terminal.write("\r")
    await waitFor("failed, exit 7")
    assert(output.includes("failed") && output.includes("exit 7"), "selected command details include its outcome")
    console.log("PASS: actual TUI slash command, grouped history, keyboard search and command details.")
  } finally {
    await writeFile(`${input.root}/tui-output.txt`, output)
    child.kill("SIGTERM")
    await child.exited
    terminal.close()
  }
}
