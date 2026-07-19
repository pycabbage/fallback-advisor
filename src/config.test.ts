import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_CLAUDE_PATH,
  DEFAULT_LOG_DIR,
  envBool,
  envList,
  loadMcpConfigFiles,
  loadSettingsEnv,
  loggingEnabled,
  matchesToolPattern,
  resolveClaudeExecutablePath,
  resolveLogDir,
  SETTINGS_ENV_WHITELIST,
} from "./config"

// ---------------------------------------------------------------------------
// resolveClaudeExecutablePath: env override with a default fallback
// ---------------------------------------------------------------------------

let prev: string | undefined

beforeEach(() => {
  prev = process.env.FALLBACK_ADVISOR_CLAUDE_PATH
})

afterEach(() => {
  if (prev === undefined) delete process.env.FALLBACK_ADVISOR_CLAUDE_PATH
  else process.env.FALLBACK_ADVISOR_CLAUDE_PATH = prev
})

test("uses FALLBACK_ADVISOR_CLAUDE_PATH when it is set", () => {
  process.env.FALLBACK_ADVISOR_CLAUDE_PATH = "/custom/path/to/claude"
  expect(resolveClaudeExecutablePath()).toBe("/custom/path/to/claude")
})

test("falls back to DEFAULT_CLAUDE_PATH when the env is unset", () => {
  delete process.env.FALLBACK_ADVISOR_CLAUDE_PATH
  expect(resolveClaudeExecutablePath()).toBe(DEFAULT_CLAUDE_PATH)
})

test("treats an empty env value as unset (uses DEFAULT_CLAUDE_PATH)", () => {
  process.env.FALLBACK_ADVISOR_CLAUDE_PATH = ""
  expect(resolveClaudeExecutablePath()).toBe(DEFAULT_CLAUDE_PATH)
})

// ---------------------------------------------------------------------------
// envBool
// ---------------------------------------------------------------------------

const ENV_BOOL_KEY = "FALLBACK_ADVISOR_TEST_BOOL"

let prevBool: string | undefined

beforeEach(() => {
  prevBool = process.env[ENV_BOOL_KEY]
})

afterEach(() => {
  if (prevBool === undefined) delete process.env[ENV_BOOL_KEY]
  else process.env[ENV_BOOL_KEY] = prevBool
})

test('envBool: "1" is true', () => {
  process.env[ENV_BOOL_KEY] = "1"
  expect(envBool(ENV_BOOL_KEY, false)).toBe(true)
})

test('envBool: "true"/"TRUE"/"True" are true (case-insensitive)', () => {
  for (const v of ["true", "TRUE", "True"]) {
    process.env[ENV_BOOL_KEY] = v
    expect(envBool(ENV_BOOL_KEY, false)).toBe(true)
  }
})

test("envBool: unset falls back to `fallback`", () => {
  delete process.env[ENV_BOOL_KEY]
  expect(envBool(ENV_BOOL_KEY, true)).toBe(true)
  expect(envBool(ENV_BOOL_KEY, false)).toBe(false)
})

test('envBool: "" (empty) falls back to `fallback`', () => {
  process.env[ENV_BOOL_KEY] = ""
  expect(envBool(ENV_BOOL_KEY, true)).toBe(true)
  expect(envBool(ENV_BOOL_KEY, false)).toBe(false)
})

test('envBool: any other value (e.g. "0", "false", "yes") is false', () => {
  for (const v of ["0", "false", "yes"]) {
    process.env[ENV_BOOL_KEY] = v
    expect(envBool(ENV_BOOL_KEY, true)).toBe(false)
  }
})

// ---------------------------------------------------------------------------
// loadSettingsEnv
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `fallback-advisor-test-${Date.now()}-${Math.random()}`
  )
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeSettings(content: unknown, file = "settings.json"): string {
  const p = join(tmpDir, file)
  writeFileSync(p, JSON.stringify(content), "utf8")
  return p
}

test("loadSettingsEnv: returns whitelisted vars from settings.json", () => {
  const p = writeSettings({
    env: {
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_test",
      AWS_REGION: "ap-northeast-1",
      CLAUDE_CODE_ENABLE_AUTO_MODE: "1",
      OTEL_TRACES_EXPORTER: "otlp",
    },
  })
  const result = loadSettingsEnv(p)
  expect(result.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBe("1")
  expect(result.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_test")
  expect(result.AWS_REGION).toBe("ap-northeast-1")
  expect(result.CLAUDE_CODE_ENABLE_AUTO_MODE).toBeUndefined()
  expect(result.OTEL_TRACES_EXPORTER).toBeUndefined()
})

test("loadSettingsEnv: skips _-prefixed (disabled) keys", () => {
  const p = writeSettings({
    env: {
      _CLAUDE_CODE_USE_BEDROCK: "1",
      _ANTHROPIC_DEFAULT_OPUS_MODEL: "some-model",
      ANTHROPIC_API_KEY: "sk-test",
    },
  })
  const result = loadSettingsEnv(p)
  expect(result._CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  expect(result._ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  expect(result.ANTHROPIC_API_KEY).toBe("sk-test")
})

test("loadSettingsEnv: returns empty object when file is absent", () => {
  expect(loadSettingsEnv(join(tmpDir, "nonexistent.json"))).toEqual({})
})

test("loadSettingsEnv: returns empty object for invalid JSON", () => {
  const p = join(tmpDir, "bad.json")
  writeFileSync(p, "not json", "utf8")
  expect(loadSettingsEnv(p)).toEqual({})
})

test("loadSettingsEnv: returns empty object when env key is missing", () => {
  const p = writeSettings({ model: "sonnet" })
  expect(loadSettingsEnv(p)).toEqual({})
})

test("SETTINGS_ENV_WHITELIST contains key inference routing vars", () => {
  const required = [
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "ANTHROPIC_AWS_WORKSPACE_ID",
    "AWS_REGION",
    "CLAUDE_CODE_USE_BEDROCK",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]
  for (const key of required) {
    expect(SETTINGS_ENV_WHITELIST.has(key)).toBe(true)
  }
})

test("SETTINGS_ENV_WHITELIST excludes behavior-affecting vars", () => {
  const excluded = [
    "CLAUDE_CODE_ENABLE_AUTO_MODE",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "MAX_THINKING_TOKENS",
    "CLAUDE_CODE_EFFORT_LEVEL",
  ]
  for (const key of excluded) {
    expect(SETTINGS_ENV_WHITELIST.has(key)).toBe(false)
  }
})

// ---------------------------------------------------------------------------
// envList
// ---------------------------------------------------------------------------

const ENV_LIST_KEY = "FALLBACK_ADVISOR_TEST_LIST"

let prevList: string | undefined

beforeEach(() => {
  prevList = process.env[ENV_LIST_KEY]
})

afterEach(() => {
  if (prevList === undefined) delete process.env[ENV_LIST_KEY]
  else process.env[ENV_LIST_KEY] = prevList
})

test("envList: splits on whitespace and drops empty tokens", () => {
  process.env[ENV_LIST_KEY] = "  a.json   b.json  "
  expect(envList(ENV_LIST_KEY)).toEqual(["a.json", "b.json"])
})

test("envList: returns [] when unset or empty", () => {
  delete process.env[ENV_LIST_KEY]
  expect(envList(ENV_LIST_KEY)).toEqual([])
  process.env[ENV_LIST_KEY] = ""
  expect(envList(ENV_LIST_KEY)).toEqual([])
})

// ---------------------------------------------------------------------------
// loadMcpConfigFiles
// ---------------------------------------------------------------------------

function writeJson(content: unknown, file: string): string {
  const p = join(tmpDir, file)
  writeFileSync(p, JSON.stringify(content), "utf8")
  return p
}

test("loadMcpConfigFiles: loads a single file's mcpServers", () => {
  const p = writeJson(
    { mcpServers: { brave: { command: "bunx", args: ["brave-mcp"] } } },
    "one.json"
  )
  const result = loadMcpConfigFiles([p])
  expect(result).toEqual({ brave: { command: "bunx", args: ["brave-mcp"] } })
})

test("loadMcpConfigFiles: merges multiple files, later files win on collision", () => {
  const a = writeJson(
    {
      mcpServers: {
        brave: { command: "a" },
        searxng: { command: "searx" },
      },
    },
    "a.json"
  )
  const b = writeJson({ mcpServers: { brave: { command: "b" } } }, "b.json")
  const result = loadMcpConfigFiles([a, b])
  expect(result).toEqual({
    brave: { command: "b" },
    searxng: { command: "searx" },
  })
})

test("loadMcpConfigFiles: throws for a missing file", () => {
  expect(() => loadMcpConfigFiles([join(tmpDir, "nonexistent.json")])).toThrow(
    /Failed to read MCP config file/
  )
})

test("loadMcpConfigFiles: throws for invalid JSON", () => {
  const p = join(tmpDir, "bad.json")
  writeFileSync(p, "not json", "utf8")
  expect(() => loadMcpConfigFiles([p])).toThrow(
    /Failed to parse MCP config file/
  )
})

test("loadMcpConfigFiles: throws when mcpServers key is missing or malformed", () => {
  const missing = writeJson({ model: "sonnet" }, "missing.json")
  expect(() => loadMcpConfigFiles([missing])).toThrow(
    /does not have a top-level "mcpServers" object/
  )

  const malformed = writeJson({ mcpServers: "not-an-object" }, "malformed.json")
  expect(() => loadMcpConfigFiles([malformed])).toThrow(
    /does not have a top-level "mcpServers" object/
  )
})

// ---------------------------------------------------------------------------
// matchesToolPattern
// ---------------------------------------------------------------------------

test("matchesToolPattern: exact match with no wildcard", () => {
  expect(
    matchesToolPattern(
      "mcp__brave__brave_web_search",
      "mcp__brave__brave_web_search"
    )
  ).toBe(true)
  expect(
    matchesToolPattern(
      "mcp__brave__brave_web_search",
      "mcp__brave__brave_summarizer"
    )
  ).toBe(false)
})

test("matchesToolPattern: trailing wildcard matches an entire server's tools", () => {
  expect(
    matchesToolPattern("mcp__brave__*", "mcp__brave__brave_web_search")
  ).toBe(true)
  expect(matchesToolPattern("mcp__brave__*", "mcp__tavily__search")).toBe(false)
})

test("matchesToolPattern: leading, middle, and bare wildcards", () => {
  expect(matchesToolPattern("*__foo", "mcp__foo")).toBe(true)
  expect(matchesToolPattern("*__foo", "mcp__food")).toBe(false)
  expect(matchesToolPattern("ab*b", "abb")).toBe(true)
  expect(matchesToolPattern("ab*b", "ab")).toBe(false)
  expect(matchesToolPattern("*", "anything")).toBe(true)
})

test("matchesToolPattern: many wildcards + repeated literal resolves without hanging (ReDoS shape)", () => {
  // Classic catastrophic-backtracking shape for `(a*)+b`-style regex: many
  // wildcards around a repeated literal, tested against a near-miss input.
  const pattern = `${"*a".repeat(20)}*b`
  const nonMatching = `${"a".repeat(5000)}c`
  const start = performance.now()
  expect(matchesToolPattern(pattern, nonMatching)).toBe(false)
  expect(performance.now() - start).toBeLessThan(100)
})

// ---------------------------------------------------------------------------
// loggingEnabled / resolveLogDir (src/logger.ts call-log configuration)
// ---------------------------------------------------------------------------

const LOG_ENV_KEYS = [
  "FALLBACK_ADVISOR_LOG",
  "FALLBACK_ADVISOR_LOG_DIR",
] as const

let prevLogEnv: Record<(typeof LOG_ENV_KEYS)[number], string | undefined>

beforeEach(() => {
  prevLogEnv = {
    FALLBACK_ADVISOR_LOG: process.env.FALLBACK_ADVISOR_LOG,
    FALLBACK_ADVISOR_LOG_DIR: process.env.FALLBACK_ADVISOR_LOG_DIR,
  }
})

afterEach(() => {
  for (const key of LOG_ENV_KEYS) {
    const value = prevLogEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("loggingEnabled: defaults to true when unset", () => {
  delete process.env.FALLBACK_ADVISOR_LOG
  expect(loggingEnabled()).toBe(true)
})

test("loggingEnabled: false/0 disables it", () => {
  process.env.FALLBACK_ADVISOR_LOG = "false"
  expect(loggingEnabled()).toBe(false)
  process.env.FALLBACK_ADVISOR_LOG = "0"
  expect(loggingEnabled()).toBe(false)
})

test("loggingEnabled: 1/true (case-insensitive) enables it", () => {
  process.env.FALLBACK_ADVISOR_LOG = "1"
  expect(loggingEnabled()).toBe(true)
  process.env.FALLBACK_ADVISOR_LOG = "TRUE"
  expect(loggingEnabled()).toBe(true)
})

test("resolveLogDir: defaults to DEFAULT_LOG_DIR when unset", () => {
  delete process.env.FALLBACK_ADVISOR_LOG_DIR
  expect(resolveLogDir()).toBe(DEFAULT_LOG_DIR)
})

test("resolveLogDir: uses FALLBACK_ADVISOR_LOG_DIR when set", () => {
  process.env.FALLBACK_ADVISOR_LOG_DIR = "/custom/log/dir"
  expect(resolveLogDir()).toBe("/custom/log/dir")
})

test("resolveLogDir: treats an empty env value as unset", () => {
  process.env.FALLBACK_ADVISOR_LOG_DIR = ""
  expect(resolveLogDir()).toBe(DEFAULT_LOG_DIR)
})
