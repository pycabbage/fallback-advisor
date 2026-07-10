// ---------------------------------------------------------------------------
// Constants (env-overridable)
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "claude-fable-5"
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000
export const DEFAULT_TIMEOUT_MS = 300_000
export const BLOCK_TRUNCATE_CHARS = 1500
export const OMIT_MARKER = "[... older history omitted ...]\n\n"

/**
 * Read a positive, finite number from an environment variable.
 * Falls back to `fallback` when the variable is unset, empty, or invalid.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
