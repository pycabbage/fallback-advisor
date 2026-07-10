import { BLOCK_TRUNCATE_CHARS, OMIT_MARKER } from "./config"

// ---------------------------------------------------------------------------
// Transcript serialization helpers (pure functions)
// ---------------------------------------------------------------------------

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…[+${s.length - max} chars]`
}

export function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n)
}

export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === "string") return b
        const block = b as { type?: string; text?: string } | null
        if (block && block.type === "text" && typeof block.text === "string") {
          return block.text
        }
        try {
          return JSON.stringify(b)
        } catch {
          return String(b)
        }
      })
      .join("\n")
  }
  try {
    return JSON.stringify(content ?? "")
  } catch {
    return String(content)
  }
}

export function serializeBlock(block: unknown): string {
  const b = block as {
    type?: string
    text?: string
    thinking?: string
    name?: string
    input?: unknown
    content?: unknown
  } | null
  const t = b?.type
  if (t === "text") return typeof b?.text === "string" ? b.text : ""
  if (t === "thinking") {
    // Drop the signature.
    return `[thinking] ${typeof b?.thinking === "string" ? b.thinking : ""}`
  }
  if (t === "tool_use") {
    const name = typeof b?.name === "string" ? b.name : "unknown"
    let inp: string
    try {
      inp = JSON.stringify(b?.input ?? {})
    } catch {
      inp = String(b?.input)
    }
    return `[tool_use name=${name}] ${truncate(inp, BLOCK_TRUNCATE_CHARS)}`
  }
  if (t === "tool_result") {
    return `[tool_result] ${truncate(
      stringifyToolResultContent(b?.content),
      BLOCK_TRUNCATE_CHARS
    )}`
  }
  return `[${t ?? "unknown"} omitted]`
}

/**
 * Format a single user/assistant message into a heading-prefixed string.
 * Other messages (e.g. type === "system") return null so the caller can skip
 * them.
 */
export function serializeMessage(msg: {
  type: string
  message: unknown
}): string | null {
  if (msg.type !== "user" && msg.type !== "assistant") return null
  const heading = msg.type === "user" ? "## User" : "## Assistant"
  const raw = msg.message as { content?: unknown } | null
  const content = raw?.content
  let body: string
  if (typeof content === "string") {
    body = content
  } else if (Array.isArray(content)) {
    body = content
      .map(serializeBlock)
      .filter((s) => s.length > 0)
      .join("\n")
  } else {
    body = ""
  }
  return `${heading}\n${body}`
}

/**
 * Enforce a total character budget on the transcript, preferring the newest
 * (trailing) content and trimming the oldest (leading) content.
 *
 * The returned transcript's length never exceeds `maxChars` in any case:
 * - When `maxChars` is large enough to hold the omission marker, the marker is
 *   prepended and the result is exactly `maxChars` characters.
 * - When `maxChars` is too small to fit the marker
 *   (`maxChars <= OMIT_MARKER.length`), the marker is omitted and only the
 *   newest `maxChars` characters are kept.
 */
export function applyCharBudget(
  transcript: string,
  maxChars: number
): { transcript: string; truncated: boolean; originalLength: number } {
  const originalLength = transcript.length
  if (originalLength <= maxChars) {
    return { transcript, truncated: false, originalLength }
  }
  if (maxChars <= OMIT_MARKER.length) {
    // No room for the marker; keep only the newest maxChars characters.
    return {
      transcript: transcript.slice(originalLength - maxChars),
      truncated: true,
      originalLength,
    }
  }
  // Subtract the marker length so the final length does not exceed maxChars.
  const sliceStart = originalLength - maxChars + OMIT_MARKER.length
  return {
    transcript: OMIT_MARKER + transcript.slice(sliceStart),
    truncated: true,
    originalLength,
  }
}
