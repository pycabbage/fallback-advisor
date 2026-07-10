import { run } from "./cli"

export type { AdvisorDeps } from "./advisor"
// Public API re-exports.
export { runFallbackAdvisor } from "./advisor"
export type { HistoryDeps } from "./history"
export type {
  FallbackAdvisorInput,
  FallbackAdvisorOutput,
  Scope,
} from "./schema"
export { server } from "./server"

// Start the CLI (which starts the stdio server by default) only when run
// directly, never on import.
if (import.meta.main) {
  void run(process.argv)
}
