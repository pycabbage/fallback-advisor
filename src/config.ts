import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Constants (env-overridable)
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "fable"
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

// ---------------------------------------------------------------------------
// Settings-file env loading (whitelist-based inference routing vars)
// ---------------------------------------------------------------------------

/**
 * Env vars that affect only inference routing and authentication.
 * Excludes behavior-altering vars (CLAUDE_CODE_ENABLE_AUTO_MODE, telemetry, etc.)
 * so that the reviewer subprocess does not inherit host-session-specific flags.
 */
export const SETTINGS_ENV_WHITELIST: ReadonlySet<string> = new Set([
  // ---- Anthropic direct API ----
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_WORKSPACE_ID",
  // ---- Anthropic AWS (Claude Platform on AWS) ----
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_API_KEY",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  // ---- Amazon Bedrock ----
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  // ---- Google Vertex AI ----
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  // ---- Microsoft Foundry ----
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  // ---- AWS credentials / region ----
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  // ---- Model routing (pin model IDs, not behavior) ----
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  // ---- TLS / mTLS ----
  "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  // ---- OAuth (headless / CI) ----
  "CLAUDE_CODE_OAUTH_TOKEN",
])

/**
 * Read inference-routing env vars from the global Claude Code settings.json,
 * filtered through SETTINGS_ENV_WHITELIST.
 *
 * Keys prefixed with `_` in the settings file are treated as disabled and skipped.
 * Returns an empty object when the file is absent or unreadable.
 *
 * @param settingsPath - Override the settings.json path (for tests).
 */
export function loadSettingsEnv(
  settingsPath: string = join(homedir(), ".claude", "settings.json")
): Record<string, string> {
  try {
    const raw = readFileSync(settingsPath, "utf8")
    const settings: unknown = JSON.parse(raw)
    if (
      settings === null ||
      typeof settings !== "object" ||
      !("env" in settings) ||
      typeof (settings as Record<string, unknown>).env !== "object" ||
      (settings as Record<string, unknown>).env === null
    ) {
      return {}
    }
    const env = (settings as { env: Record<string, unknown> }).env
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("_")) continue
      if (!SETTINGS_ENV_WHITELIST.has(key)) continue
      result[key] = String(value)
    }
    return result
  } catch {
    return {}
  }
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

/**
 * Split a space-separated env var into a list of tokens (e.g. file paths or
 * glob patterns). Collapses runs of whitespace and drops empty tokens.
 * Returns `[]` when the variable is unset or empty.
 */
export function envList(name: string): string[] {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return []
  return raw.split(/\s+/).filter((s) => s.length > 0)
}

// ---------------------------------------------------------------------------
// MCP server config loading (--mcp-config / FALLBACK_ADVISOR_MCP_CONFIG)
// ---------------------------------------------------------------------------

/**
 * Minimal shape this module cares about: an `mcpServers` map whose values are
 * passed through untouched to the Agent SDK's `mcpServers` option.
 */
export type McpServersConfig = Record<string, unknown>

/**
 * Load and merge one or more `{"mcpServers": {...}}` JSON files (the same
 * shape as `.mcp.json` / `.claude.mcp.json`), in the same format as Claude
 * Code's own `--mcp-config` flag — except this only accepts file paths, not
 * inline JSON strings. Unlike `loadSettingsEnv` (which silently returns `{}`
 * on any failure, since it reads an implicit, not-user-specified path), this
 * throws on a missing file, invalid JSON, or a missing/malformed `mcpServers`
 * key: the caller explicitly opted in via `--mcp-config`, so a typo'd path or
 * a malformed file should surface as an error rather than silently yield no
 * servers.
 *
 * Later files win on a server-name collision (plain `Object.assign` merge
 * order, left to right).
 */
export function loadMcpConfigFiles(paths: string[]): McpServersConfig {
  const merged: McpServersConfig = {}
  for (const path of paths) {
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to read MCP config file ${path}: ${reason}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to parse MCP config file ${path} as JSON: ${reason}`
      )
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("mcpServers" in parsed) ||
      typeof (parsed as Record<string, unknown>).mcpServers !== "object" ||
      (parsed as Record<string, unknown>).mcpServers === null
    ) {
      throw new Error(
        `MCP config file ${path} does not have a top-level "mcpServers" object`
      )
    }
    Object.assign(
      merged,
      (parsed as { mcpServers: Record<string, unknown> }).mcpServers
    )
  }
  return merged
}

// ---------------------------------------------------------------------------
// Tool-name glob matching (--allow-tool / FALLBACK_ADVISOR_ALLOW_TOOL)
// ---------------------------------------------------------------------------

/**
 * Match `toolName` against a glob `pattern` where `*` matches any substring
 * (including empty) and every other character matches literally.
 *
 * Deliberately hand-rolled instead of translating to a backtracking regex
 * (replacing each wildcard with ".*" and anchoring the result): a pattern
 * with several wildcards interleaved with a repeated literal (e.g. `*a*a*a*a*`)
 * is a textbook catastrophic-backtracking shape against an adversarial
 * input that almost-but-not-quite matches. `toolName` here is a tool name
 * declared by a connected MCP server (via `--mcp-config`), not something
 * this process controls, so a malicious or compromised server could pick
 * one specifically to hang the reviewer on `canUseTool`. Matching each
 * segment between wildcards via sequential `indexOf` scans from the
 * previous match position is linear in `toolName.length` and has no
 * backtracking by construction, closing that off regardless of `pattern`.
 */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  const segments = pattern.split("*")
  if (segments.length === 1) return pattern === toolName

  const first = segments[0]
  const last = segments[segments.length - 1]
  if (first !== undefined && !toolName.startsWith(first)) return false
  if (last !== undefined && !toolName.endsWith(last)) return false

  let cursor = first?.length ?? 0
  const end = toolName.length - (last?.length ?? 0)
  if (cursor > end) return false

  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i]
    if (segment === undefined || segment === "") continue
    const idx = toolName.indexOf(segment, cursor)
    if (idx === -1 || idx > end - segment.length) return false
    cursor = idx + segment.length
  }
  return true
}
