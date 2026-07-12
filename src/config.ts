import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Constants (env-overridable)
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "claude-fable-5"
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000
export const DEFAULT_TIMEOUT_MS = 300_000
export const BLOCK_TRUNCATE_CHARS = 1500
export const OMIT_MARKER = "[... older history omitted ...]\n\n"
export const DEFAULT_MAX_TURNS = 1
export const DEFAULT_MAX_TURNS_WITH_TOOLS = 10

/** Standard install location of the host Claude Code CLI. */
export const DEFAULT_CLAUDE_PATH = join(homedir(), ".local", "bin", "claude")

/**
 * Resolve the host Claude Code executable that the Agent SDK spawns.
 * This MCP server always runs under Claude Code, so the executable is present
 * on the machine; pointing the SDK at it avoids the compiled binary's failure
 * to resolve the SDK's bundled native binary via import.meta.url.
 */
export function resolveClaudeExecutablePath(): string {
  const raw = process.env.FALLBACK_ADVISOR_CLAUDE_PATH
  return raw === undefined || raw === "" ? DEFAULT_CLAUDE_PATH : raw
}

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

/**
 * Read a boolean environment variable. "1" or "true" (case-insensitive) is
 * true; unset or empty falls back to `fallback`; any other value is false.
 */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  return raw === "1" || raw.toLowerCase() === "true"
}
