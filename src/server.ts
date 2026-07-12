import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"
import { version } from "../package.json"
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

// Server-level instructions surfaced to the MCP client, so agents know to reach
// for this tool as a fallback when Claude Code's built-in advisor tool fails.
const SERVER_INSTRUCTIONS = `FallbackAdvisor is a fallback for Claude Code's built-in advisor tool. Use it when the built-in advisor fails: for example, when an advisor call hard-fails or returns an error such as "The advisor tool is unavailable." instead of a review. When that happens, call FallbackAdvisor to still obtain the second opinion you were seeking, so your turn is not interrupted.

It automatically reads the current conversation's full transcript (the task, every tool call and its result, and your reasoning) from the local Claude Code history, so you do NOT need to paste or summarize any history; usually you call it with no arguments.

When to call it:
- Right after a built-in advisor call fails or errors out instead of returning a review: retry the same request with this tool rather than giving up on the second opinion.
- Use it with the same timing you would have used the built-in advisor (before committing to an approach, when stuck, before declaring a task done), once the built-in path is unavailable.

How to call it:
- Usually pass no arguments; it reviews the current session.
- context (optional): a specific question or instruction for the reviewer, for example the same thing you wanted the built-in advisor to weigh in on.
- scope (optional): "session" (default) reviews the current conversation; "project" reviews all of the project's sessions in chronological order.
- cwd (optional): set this only if the server's working directory differs from the target project and the tool reports that no sessions were found (or set the FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR environment variable).

How to use the result:
- advice is the reviewer's second opinion; give it serious weight, but adapt if it fails empirically or primary-source evidence contradicts a specific claim.
- isError: true means the review did not complete normally (a refusal with no fallback, an error, or a timeout); read advice for the reason.
- Safety refusals are respected and reported, not bypassed. If the primary model refuses, the SDK's refusal-fallback lets another model complete the review; fallbackOccurred and respondedModel show which model answered.`

export const server = new McpServer(
  {
    name: "FallbackAdvisor",
    title: "FallbackAdvisor",
    description:
      "An MCP server that passes the transcript of the current conversation (or the entire project) to a stronger reviewer model to obtain a second opinion.",
    version,
    websiteUrl: "https://github.com/pycabbage/fallback-advisor",
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  }
)

server.registerTool(
  "FallbackAdvisor",
  {
    title: "FallbackAdvisor",
    description:
      "A fallback for Claude Code's built-in advisor. When the built-in advisor tool fails (for example, it hard-fails or returns an error like \"The advisor tool is unavailable.\") instead of returning a review, call this to still get the second opinion so your turn is not interrupted. It automatically reads the current conversation's transcript, so you can usually call it with no arguments. Refusals, errors, and timeouts are reported in a structured form (isError); if the model refuses, the SDK's refusal-fallback completes the review with another model.",
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
        requestedModel: process.env.FALLBACK_ADVISOR_MODEL ?? DEFAULT_MODEL,
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
