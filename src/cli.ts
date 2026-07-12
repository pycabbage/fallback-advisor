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
  maxTurns?: string
  allowRead?: boolean
  allowWeb?: boolean
}): void {
  if (opts.model !== undefined) process.env.FALLBACK_ADVISOR_MODEL = opts.model
  if (opts.timeoutMs !== undefined)
    process.env.FALLBACK_ADVISOR_TIMEOUT_MS = opts.timeoutMs
  if (opts.maxChars !== undefined)
    process.env.FALLBACK_ADVISOR_MAX_CHARS = opts.maxChars
  if (opts.maxTurns !== undefined)
    process.env.FALLBACK_ADVISOR_MAX_TURNS = opts.maxTurns
  if (opts.allowRead !== undefined)
    process.env.FALLBACK_ADVISOR_ALLOW_READ = String(opts.allowRead)
  if (opts.allowWeb !== undefined)
    process.env.FALLBACK_ADVISOR_ALLOW_WEB = String(opts.allowWeb)
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
    .option(
      "--allow-read",
      "Allow the reviewer to use the Read tool, unrestricted (equivalent to a Read(*) permission rule)"
    )
    .option(
      "--allow-web",
      "Allow the reviewer to use WebSearch and WebFetch (default: on; pass --no-allow-web to disable)"
    )
    .option(
      "--no-allow-web",
      "Disable WebSearch/WebFetch for the reviewer (they are enabled by default)"
    )
    .option(
      "--max-turns <n>",
      "Maximum agentic turns for the reviewer (default: 10, since --allow-web is on by default; 1 only if both tool flags above are disabled)"
    )
    .action(async (opts) => {
      applyServerOptions({
        model: opts.model,
        timeoutMs: opts.timeoutMs,
        maxChars: opts.maxChars,
        maxTurns: opts.maxTurns,
        allowRead: opts.allowRead,
        allowWeb: opts.allowWeb,
      })
      await handlers.onServe()
    })

  program.addHelpText(
    "after",
    `
Environment variables:
  FALLBACK_ADVISOR_MODEL               Reviewer model (default: claude-fable-5). Same as --model.
  FALLBACK_ADVISOR_TIMEOUT_MS          Per-call inference timeout in ms (default: 300000). Same as --timeout-ms.
  FALLBACK_ADVISOR_MAX_CHARS           Max transcript characters to send (default: 200000). Same as --max-chars.
  FALLBACK_ADVISOR_CLAUDE_PATH         Path to the host Claude Code executable the SDK spawns
                                       (default: ~/.local/bin/claude). Set this if Claude Code is
                                       installed elsewhere or on a non-Linux OS.
  FALLBACK_ADVISOR_MAX_TURNS           Max agentic turns for the reviewer (default: 10, since
                                       FALLBACK_ADVISOR_ALLOW_WEB is on by default; 1 only if both
                                       tool flags below are disabled). Same as --max-turns.
  FALLBACK_ADVISOR_ALLOW_READ          Allow the reviewer to use the Read tool (default: off/false).
                                       Unrestricted (Read(*)-equivalent), not sandboxed to the
                                       project dir. Same as --allow-read.
  FALLBACK_ADVISOR_ALLOW_WEB           Allow the reviewer to use WebSearch/WebFetch (default: on/true).
                                       Same as --allow-web. Disable with --no-allow-web or by setting
                                       this to false/0. This alone already risks transcript
                                       exfiltration via a crafted query/URL if the transcript contains
                                       a prompt injection; enabling FALLBACK_ADVISOR_ALLOW_READ too adds
                                       a local-file exfiltration path.
  FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR  Project directory used to locate session history when the
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
