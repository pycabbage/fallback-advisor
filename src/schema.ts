import { z } from "zod"

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export type Scope = "session" | "project"

export const zFallbackAdvisorInput = z.object({
  context: z
    .string()
    .optional()
    .describe(
      "Additional instruction or question for the reviewer; appended to the end of the prompt."
    ),
  scope: z
    .enum(["session", "project"])
    .optional()
    .describe(
      '"session" (default) = the entire current conversation. "project" = all sessions of the project concatenated in chronological order.'
    ),
  cwd: z
    .string()
    .optional()
    .describe("Override for project directory detection."),
})

export const zFallbackAdvisorOutput = z.object({
  advice: z.string(),
  requestedModel: z.string(),
  respondedModel: z.string().nullable(),
  fallbackOccurred: z.boolean(),
  fallbackFrom: z.string().optional(),
  fallbackTo: z.string().optional(),
  refusalCategory: z.string().optional(),
  scope: z.string(),
  sessionCount: z.number(),
  messageCount: z.number(),
  transcriptChars: z.number(),
  costUsd: z.number().optional(),
  numTurns: z.number().optional(),
  note: z.string().optional(),
  // `isError` is central to this tool's robustness. It is included in the
  // output so that refusals, errors, and timeouts do not interrupt the caller
  // but are instead reported transparently in a structured form.
  isError: z.boolean(),
})

export type FallbackAdvisorInput = z.infer<typeof zFallbackAdvisorInput>
export type FallbackAdvisorOutput = z.infer<typeof zFallbackAdvisorOutput>
