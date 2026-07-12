import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  DEFAULT_CLAUDE_PATH,
  envBool,
  resolveClaudeExecutablePath,
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
