import { expect, test } from "bun:test"
import { applyServerOptions, buildProgram } from "./cli"

const ENV_KEYS = [
  "FALLBACK_ADVISOR_MODEL",
  "FALLBACK_ADVISOR_TIMEOUT_MS",
  "FALLBACK_ADVISOR_MAX_CHARS",
] as const

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return {
    FALLBACK_ADVISOR_MODEL: process.env.FALLBACK_ADVISOR_MODEL,
    FALLBACK_ADVISOR_TIMEOUT_MS: process.env.FALLBACK_ADVISOR_TIMEOUT_MS,
    FALLBACK_ADVISOR_MAX_CHARS: process.env.FALLBACK_ADVISOR_MAX_CHARS,
  }
}

function restoreEnv(snapshot: ReturnType<typeof snapshotEnv>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// ---------------------------------------------------------------------------
// applyServerOptions
// ---------------------------------------------------------------------------

test("applyServerOptions: sets all three env vars when all provided", () => {
  const prev = snapshotEnv()
  try {
    applyServerOptions({
      model: "claude-a",
      timeoutMs: "1234",
      maxChars: "5678",
    })

    expect(process.env.FALLBACK_ADVISOR_MODEL).toBe("claude-a")
    expect(process.env.FALLBACK_ADVISOR_TIMEOUT_MS).toBe("1234")
    expect(process.env.FALLBACK_ADVISOR_MAX_CHARS).toBe("5678")
  } finally {
    restoreEnv(prev)
  }
})

test("applyServerOptions: leaves an env var untouched when its option is undefined", () => {
  const prev = snapshotEnv()
  try {
    process.env.FALLBACK_ADVISOR_MODEL = "sentinel-model"

    applyServerOptions({ timeoutMs: "999", maxChars: "111" })

    expect(process.env.FALLBACK_ADVISOR_MODEL).toBe("sentinel-model")
    expect(process.env.FALLBACK_ADVISOR_TIMEOUT_MS).toBe("999")
    expect(process.env.FALLBACK_ADVISOR_MAX_CHARS).toBe("111")
  } finally {
    restoreEnv(prev)
  }
})

// ---------------------------------------------------------------------------
// buildProgram
// ---------------------------------------------------------------------------

test("buildProgram: default action invokes onServe and applies options", async () => {
  const prev = snapshotEnv()
  try {
    let served = false
    const program = buildProgram({
      onServe: () => {
        served = true
      },
    })

    await program.parseAsync(["--model", "claude-x", "--max-chars", "4242"], {
      from: "user",
    })

    expect(served).toBe(true)
    expect(process.env.FALLBACK_ADVISOR_MODEL).toBe("claude-x")
    expect(process.env.FALLBACK_ADVISOR_MAX_CHARS).toBe("4242")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: the --model flag wins over a pre-set environment variable", async () => {
  const prev = snapshotEnv()
  try {
    process.env.FALLBACK_ADVISOR_MODEL = "claude-env"

    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--model", "claude-flag"], { from: "user" })

    expect(process.env.FALLBACK_ADVISOR_MODEL).toBe("claude-flag")
  } finally {
    restoreEnv(prev)
  }
})
