// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * System prompt given to the reviewer.
 * It contains no instruction to disable, suppress, or bypass any safety
 * mechanism. Model refusals are respected as refusals and reported
 * transparently.
 */
export const REVIEWER_SYSTEM_PROMPT =
  "You are a stronger reviewer consulted by an AI coding agent. Below you are given the agent's entire conversation transcript (its task, tool calls and their results, and its reasoning). Your role is to provide a candid, specific second opinion.\n\n- Point out mistaken assumptions, blind spots, better approaches, and risks, in priority order.\n- No flattery or verbose summaries; focus on high-signal points.\n- State your confidence for uncertain points.\n- You only return advice; you do not execute tools or modify files."

/**
 * Build the user prompt from the serialized transcript and an optional
 * additional instruction from the requester.
 */
export function buildPrompt(transcript: string, context?: string): string {
  let prompt = `The following is the agent's conversation transcript.\n\n${transcript}`
  const trimmed = context?.trim()
  if (trimmed) {
    prompt += `\n\n---\nAdditional instruction from the requester:\n${trimmed}`
  }
  prompt += "\n\nBased on the above, provide your review as the reviewer."
  return prompt
}
