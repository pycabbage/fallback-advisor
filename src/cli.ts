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

  return program
}

export async function run(argv: string[]): Promise<void> {
  await buildProgram({
    onServe: () => server.connect(new StdioServerTransport()),
  }).parseAsync(argv)
}
