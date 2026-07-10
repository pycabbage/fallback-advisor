import { afterEach, beforeEach, expect, test } from "bun:test"
import { DEFAULT_CLAUDE_PATH, resolveClaudeExecutablePath } from "./config"

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
