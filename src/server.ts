import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"
import { runFallbackAdvisor } from "./advisor"
import { DEFAULT_MODEL } from "./config"
import {
  type FallbackAdvisorOutput,
  zFallbackAdvisorInput,
  zFallbackAdvisorOutput,
} from "./schema"

// ---------------------------------------------------------------------------
// MCP server wiring (no side effects at import time except registration)
// ---------------------------------------------------------------------------

export const server = new McpServer({
  name: "FallbackAdvisor",
  title: "FallbackAdvisor",
  description:
    "An MCP server that passes the transcript of the current conversation (or the entire project) to a stronger reviewer model to obtain a second opinion.",
  version: "0.0.0",
})

server.registerTool(
  "FallbackAdvisor",
  {
    title: "FallbackAdvisor",
    description:
      "Returns a second opinion using standard Claude Agent SDK inference. If the model refuses and the SDK's default refusal-fallback kicks in, it completes with a different model and transparently reports the responding model and whether a fallback occurred. Refusals without fallback, errors, and timeouts are not swallowed but returned in a structured form.",
    inputSchema: zFallbackAdvisorInput,
    outputSchema: zFallbackAdvisorOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input: z.infer<typeof zFallbackAdvisorInput>) => {
    try {
      const output = await runFallbackAdvisor(input)
      return {
        content: [{ type: "text", text: output.advice }],
        structuredContent: output,
        isError: output.isError,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const advice = `An error occurred while running FallbackAdvisor: ${message}`
      const output: FallbackAdvisorOutput = {
        advice,
        requestedModel:
          input.model ?? process.env.FALLBACK_ADVISOR_MODEL ?? DEFAULT_MODEL,
        respondedModel: null,
        fallbackOccurred: false,
        scope: input.scope ?? "session",
        sessionCount: 0,
        messageCount: 0,
        transcriptChars: 0,
        isError: true,
      }
      return {
        content: [{ type: "text", text: advice }],
        structuredContent: output,
        isError: true,
      }
    }
  }
)
