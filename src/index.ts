import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { server } from "./server"

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

// Start the stdio server only when run directly, never on import.
if (import.meta.main) {
  void server.connect(new StdioServerTransport())
}
