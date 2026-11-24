# OpenCode Command History

Records OpenCode shell commands by session and user message, with timestamps, working directories and exit status.

Tested with OpenCode 2.3.2 and Bun 1.4.3 on Linux. Requires the V2 plugin API.

## Install from npm

Add the [npm package](https://www.npmjs.com/package/opencode-session-commands-history) to your project's `opencode.jsonc`, or `~/.config/opencode/opencode.jsonc` for all projects. Merge this with your existing configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-session-commands-history@0.1.0",
      "options": {
        "recordPrompts": false,
        "notifyOnTurn": true,
        "autoShow": false
      }
    }
  ]
}
```

OpenCode installs the package and reloads configuration automatically. Use `/reload` to force a reload.

For a local checkout, run `bun install --frozen-lockfile --ignore-scripts` in the plugin directory and use its absolute path as the `package` value instead.

## View commands

Open `/command-history` in a TUI session. Search the list, press Enter for command details, or Escape to close. Reopen to refresh. Viewing history never runs saved commands or calls a model.

Successful turns that ran commands show a notification. Set `autoShow: true` to open history instead. [See sample output](examples/sample-history.txt).

For offline use with a source checkout, run these from the plugin directory:

```sh
# List recorded session IDs.
bun src/cli.ts

# Show one session.
bun src/cli.ts ses_example

# Export one deduplicated JSON array.
bun src/cli.ts ses_example --json

# Use the same directory as a custom plugin configuration.
bun src/cli.ts ses_example --directory /absolute/path/to/history
```

Desktop, web and Mini users can use the CLI. Integrations can use the read-only RPC defined in `src/rpc.ts`.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `directory` | `$XDG_STATE_HOME/opencode/command-history`, or `~/.local/state/opencode/command-history` | Absolute storage path on the server. |
| `recordPrompts` | `false` | Save user message text alongside message IDs. |
| `notifyOnTurn` | `true` | Show a notification after successful turns that ran commands. |
| `autoShow` | `false` | Open history instead of showing a notification. |

Without `recordPrompts`, the connected viewer displays available prompt text from the session without saving it.

## Storage and limits

Each session has a plaintext `<sessionId>.jsonl` file. Command arguments are saved exactly and may contain secrets. Output and environment variables aren't saved; prompt text is opt-in. New directories use `0700` and files use `0600` on POSIX.

History survives session deletion and has no retention limit. To clear it, disable the plugin, delete the journal files, then reload. Turning off `recordPrompts` doesn't erase previously saved text.

- Captures the built-in `shell` tool, including parallel, background and Code Mode calls. It records whole invocations, not individual commands inside scripts. External terminals and tools that spawn their own processes aren't captured.
- Commands belong to the latest user message delivered before the assistant step. Child sessions have separate histories.
- Capture starts when the plugin loads; old commands aren't backfilled. Unresolved origins are shown as unknown. Reloads mark unfinished commands `unknown` until an exit is observed.
- Crashes or storage failures can lose records. Check server logs for warnings. Use separate history directories for separate servers running the same session.

## Develop and validate

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
bun run test:integration
```

Run these from the source checkout. Integration tests need an installed `opencode` and Linux/macOS for the terminal check. They use an isolated server under `/tmp/opencode` and a local model fixture, with no paid inference or changes to your global configuration.

Package with `bun pm pack`. For a tarball install, extract it, run `bun install --production --ignore-scripts`, and point the plugin configuration to that directory.
