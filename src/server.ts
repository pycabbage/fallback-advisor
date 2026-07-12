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
// for this tool as a fallback (advisor failure) or primary reviewer (Bedrock etc.).
const SERVER_INSTRUCTIONS = `FallbackAdvisor provides a second-opinion review of the current work session from a dedicated reviewer model. Call it at key decision points during any task — regardless of whether a built-in advisor tool is available in your environment.

When to call it:
- Before committing to a non-trivial approach: when you have a plan but want an outside perspective on blind spots or better alternatives.
- When stuck: if you are uncertain how to proceed and want a second opinion.
- Before declaring a significant task done: to catch mistakes, risks, or missed requirements.
- Right after a built-in advisor call fails or returns an error such as "The advisor tool is unavailable.": retry with this tool instead of giving up on the review.

If a tool named advisor_20260301 (or another built-in advisor) is listed among your available tools, prefer it first; if it is not listed, or it fails, use FallbackAdvisor directly. Do not call it when the built-in advisor has already returned a review for the same checkpoint.

It automatically reads the current conversation's full transcript (the task, every tool call and its result, and your reasoning) from the local Claude Code history, so you do NOT need to paste or summarize any history; usually you call it with no arguments.

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
      "A second-opinion reviewer: call this tool at key decision points during any non-trivial task (before committing to an approach, when stuck, before declaring a significant task done) — regardless of whether a built-in advisor tool exists in your environment. If a tool named advisor_20260301 (or another built-in advisor) is listed among your available tools, prefer it first; if it is not listed, or it fails or returns an error such as \"The advisor tool is unavailable.\", use FallbackAdvisor directly. It automatically reads the current conversation's transcript, so you can usually call it with no arguments. Refusals, errors, and timeouts are reported in a structured form (isError); if the model refuses, the SDK's refusal-fallback completes the review with another model.",
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
