import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_CLAUDE_PATH,
  envBool,
  loadSettingsEnv,
  resolveClaudeExecutablePath,
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
