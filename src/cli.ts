import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Command } from "commander"
import { version } from "../package.json"
import { server } from "./server"

// ---------------------------------------------------------------------------
// Operator-facing CLI (commander.js), wired for dependency injection so it
// is safe and easy to exercise in tests. No top-level side effects: nothing
// here runs until run() is called.
// ---------------------------------------------------------------------------

export function applyServerOptions(opts: {
  model?: string
  timeoutMs?: string
  maxChars?: string
}): void {
  if (opts.model !== undefined) process.env.FALLBACK_ADVISOR_MODEL = opts.model
  if (opts.timeoutMs !== undefined)
    process.env.FALLBACK_ADVISOR_TIMEOUT_MS = opts.timeoutMs
  if (opts.maxChars !== undefined)
    process.env.FALLBACK_ADVISOR_MAX_CHARS = opts.maxChars
}

export function buildProgram(handlers: {
  onServe: () => void | Promise<void>
}): Command {
  const program = new Command()

  program
    .name("fallback-advisor")
    .description(
      "MCP server that gets a second opinion from a stronger reviewer model."
    )
    .version(version)
    .option("--model <model>", "Reviewer model override")
    .option("--timeout-ms <ms>", "Per-call inference timeout in milliseconds")
    .option("--max-chars <n>", "Maximum transcript characters to send")
    .action(async (opts) => {
      applyServerOptions({
        model: opts.model,
        timeoutMs: opts.timeoutMs,
        maxChars: opts.maxChars,
      })
      await handlers.onServe()
    })

  program.addHelpText(
    "after",
    `
Environment variables:
  FALLBACK_ADVISOR_MODEL        Reviewer model (default: claude-fable-5). Same as --model.
  FALLBACK_ADVISOR_TIMEOUT_MS   Per-call inference timeout in ms (default: 300000). Same as --timeout-ms.
  FALLBACK_ADVISOR_MAX_CHARS    Max transcript characters to send (default: 200000). Same as --max-chars.
  FALLBACK_ADVISOR_CLAUDE_PATH  Path to the host Claude Code executable the SDK spawns
                                (default: ~/.local/bin/claude). Set this if Claude Code is
                                installed elsewhere or on a non-Linux OS.
  CLAUDE_PROJECT_DIR            Project directory used to locate session history when the
                                server's working directory differs from the target project.

CLI flags take precedence over the corresponding environment variables.`
  )

  return program
}

export async function run(argv: string[]): Promise<void> {
  await buildProgram({
    onServe: () => server.connect(new StdioServerTransport()),
  }).parseAsync(argv)
}
