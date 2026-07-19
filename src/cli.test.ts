import { expect, test } from "bun:test"
import { applyServerOptions, buildProgram } from "./cli"

const ENV_KEYS = [
  "FALLBACK_ADVISOR_MODEL",
  "FALLBACK_ADVISOR_TIMEOUT_MS",
  "FALLBACK_ADVISOR_MAX_CHARS",
  "FALLBACK_ADVISOR_MAX_TURNS",
  "FALLBACK_ADVISOR_ALLOW_READ",
  "FALLBACK_ADVISOR_ALLOW_WEB",
  "FALLBACK_ADVISOR_MCP_CONFIG",
  "FALLBACK_ADVISOR_ALLOW_TOOL",
  "FALLBACK_ADVISOR_LOG",
  "FALLBACK_ADVISOR_LOG_DIR",
] as const

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return {
    FALLBACK_ADVISOR_MODEL: process.env.FALLBACK_ADVISOR_MODEL,
    FALLBACK_ADVISOR_TIMEOUT_MS: process.env.FALLBACK_ADVISOR_TIMEOUT_MS,
    FALLBACK_ADVISOR_MAX_CHARS: process.env.FALLBACK_ADVISOR_MAX_CHARS,
    FALLBACK_ADVISOR_MAX_TURNS: process.env.FALLBACK_ADVISOR_MAX_TURNS,
    FALLBACK_ADVISOR_ALLOW_READ: process.env.FALLBACK_ADVISOR_ALLOW_READ,
    FALLBACK_ADVISOR_ALLOW_WEB: process.env.FALLBACK_ADVISOR_ALLOW_WEB,
    FALLBACK_ADVISOR_MCP_CONFIG: process.env.FALLBACK_ADVISOR_MCP_CONFIG,
    FALLBACK_ADVISOR_ALLOW_TOOL: process.env.FALLBACK_ADVISOR_ALLOW_TOOL,
    FALLBACK_ADVISOR_LOG: process.env.FALLBACK_ADVISOR_LOG,
    FALLBACK_ADVISOR_LOG_DIR: process.env.FALLBACK_ADVISOR_LOG_DIR,
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

test("applyServerOptions: sets the three new env vars when the corresponding opts are provided", () => {
  const prev = snapshotEnv()
  try {
    applyServerOptions({
      maxTurns: "7",
      allowRead: true,
      allowWeb: false,
    })

    expect(process.env.FALLBACK_ADVISOR_MAX_TURNS).toBe("7")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_READ).toBe("true")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_WEB).toBe("false")
  } finally {
    restoreEnv(prev)
  }
})

test("applyServerOptions: leaves the three new env vars untouched when undefined", () => {
  const prev = snapshotEnv()
  try {
    process.env.FALLBACK_ADVISOR_MAX_TURNS = "sentinel-max-turns"
    process.env.FALLBACK_ADVISOR_ALLOW_READ = "sentinel-allow-read"
    process.env.FALLBACK_ADVISOR_ALLOW_WEB = "sentinel-allow-web"

    applyServerOptions({ model: "claude-a" })

    expect(process.env.FALLBACK_ADVISOR_MAX_TURNS).toBe("sentinel-max-turns")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_READ).toBe("sentinel-allow-read")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_WEB).toBe("sentinel-allow-web")
  } finally {
    restoreEnv(prev)
  }
})

test("applyServerOptions: joins mcpConfig/allowTool arrays with a space", () => {
  const prev = snapshotEnv()
  try {
    applyServerOptions({
      mcpConfig: ["a.json", "b.json"],
      allowTool: ["mcp__brave__*", "mcp__tavily__search"],
    })

    expect(process.env.FALLBACK_ADVISOR_MCP_CONFIG).toBe("a.json b.json")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_TOOL).toBe(
      "mcp__brave__* mcp__tavily__search"
    )
  } finally {
    restoreEnv(prev)
  }
})

test("applyServerOptions: leaves mcpConfig/allowTool env vars untouched when undefined", () => {
  const prev = snapshotEnv()
  try {
    process.env.FALLBACK_ADVISOR_MCP_CONFIG = "sentinel-mcp-config"
    process.env.FALLBACK_ADVISOR_ALLOW_TOOL = "sentinel-allow-tool"

    applyServerOptions({ model: "claude-a" })

    expect(process.env.FALLBACK_ADVISOR_MCP_CONFIG).toBe("sentinel-mcp-config")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_TOOL).toBe("sentinel-allow-tool")
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

test("buildProgram: --allow-read --allow-web --max-turns 5 set the corresponding env vars", async () => {
  const prev = snapshotEnv()
  try {
    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(
      ["--allow-read", "--allow-web", "--max-turns", "5"],
      { from: "user" }
    )

    expect(process.env.FALLBACK_ADVISOR_ALLOW_READ).toBe("true")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_WEB).toBe("true")
    expect(process.env.FALLBACK_ADVISOR_MAX_TURNS).toBe("5")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: --no-allow-web sets FALLBACK_ADVISOR_ALLOW_WEB to false", async () => {
  const prev = snapshotEnv()
  try {
    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--no-allow-web"], { from: "user" })

    expect(process.env.FALLBACK_ADVISOR_ALLOW_WEB).toBe("false")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: with neither --allow-web nor --no-allow-web passed, FALLBACK_ADVISOR_ALLOW_WEB is left untouched", async () => {
  const prev = snapshotEnv()
  try {
    // Defining both --allow-web and --no-allow-web on the same Command means
    // commander leaves opts.allowWeb undefined when neither flag is passed
    // (its "true unless --no-x is seen" auto-default only kicks in when
    // --no-x is defined alone, without a matching --x). This proves
    // applyServerOptions' `if (opts.allowWeb !== undefined)` guard actually
    // sees `undefined` here and so does not clobber a pre-set env var.
    process.env.FALLBACK_ADVISOR_ALLOW_WEB = "sentinel-allow-web"

    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--model", "claude-x"], { from: "user" })

    expect(process.env.FALLBACK_ADVISOR_ALLOW_WEB).toBe("sentinel-allow-web")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: --mcp-config joins multiple file paths with a space into FALLBACK_ADVISOR_MCP_CONFIG", async () => {
  const prev = snapshotEnv()
  try {
    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--mcp-config", "a.json", "b.json"], {
      from: "user",
    })

    expect(process.env.FALLBACK_ADVISOR_MCP_CONFIG).toBe("a.json b.json")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: --allow-tool joins multiple glob patterns with a space into FALLBACK_ADVISOR_ALLOW_TOOL", async () => {
  const prev = snapshotEnv()
  try {
    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(
      ["--allow-tool", "mcp__brave__*", "mcp__tavily__search"],
      { from: "user" }
    )

    expect(process.env.FALLBACK_ADVISOR_ALLOW_TOOL).toBe(
      "mcp__brave__* mcp__tavily__search"
    )
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: with neither --mcp-config nor --allow-tool passed, their env vars are left untouched", async () => {
  const prev = snapshotEnv()
  try {
    process.env.FALLBACK_ADVISOR_MCP_CONFIG = "sentinel-mcp-config"
    process.env.FALLBACK_ADVISOR_ALLOW_TOOL = "sentinel-allow-tool"

    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--model", "claude-x"], { from: "user" })

    expect(process.env.FALLBACK_ADVISOR_MCP_CONFIG).toBe("sentinel-mcp-config")
    expect(process.env.FALLBACK_ADVISOR_ALLOW_TOOL).toBe("sentinel-allow-tool")
  } finally {
    restoreEnv(prev)
  }
})

// ---------------------------------------------------------------------------
// --log / --no-log / --log-dir
// ---------------------------------------------------------------------------

test("applyServerOptions: sets FALLBACK_ADVISOR_LOG/_LOG_DIR when log/logDir are provided", () => {
  const prev = snapshotEnv()
  try {
    applyServerOptions({ log: false, logDir: "/tmp/custom-logs" })

    expect(process.env.FALLBACK_ADVISOR_LOG).toBe("false")
    expect(process.env.FALLBACK_ADVISOR_LOG_DIR).toBe("/tmp/custom-logs")
  } finally {
    restoreEnv(prev)
  }
})

test("applyServerOptions: leaves FALLBACK_ADVISOR_LOG/_LOG_DIR untouched when undefined", () => {
  const prev = snapshotEnv()
  try {
    process.env.FALLBACK_ADVISOR_LOG = "sentinel-log"
    process.env.FALLBACK_ADVISOR_LOG_DIR = "sentinel-log-dir"

    applyServerOptions({ model: "claude-a" })

    expect(process.env.FALLBACK_ADVISOR_LOG).toBe("sentinel-log")
    expect(process.env.FALLBACK_ADVISOR_LOG_DIR).toBe("sentinel-log-dir")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: --no-log sets FALLBACK_ADVISOR_LOG to false", async () => {
  const prev = snapshotEnv()
  try {
    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--no-log"], { from: "user" })

    expect(process.env.FALLBACK_ADVISOR_LOG).toBe("false")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: --log-dir sets FALLBACK_ADVISOR_LOG_DIR", async () => {
  const prev = snapshotEnv()
  try {
    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--log-dir", "/tmp/custom-logs"], {
      from: "user",
    })

    expect(process.env.FALLBACK_ADVISOR_LOG_DIR).toBe("/tmp/custom-logs")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: with neither --log nor --no-log passed, FALLBACK_ADVISOR_LOG is left untouched", async () => {
  const prev = snapshotEnv()
  try {
    // Same commander quirk exercised for --allow-web above: defining --log
    // and --no-log together means neither flag being passed leaves
    // opts.log === undefined, so applyServerOptions' guard does not clobber
    // a pre-set env var.
    process.env.FALLBACK_ADVISOR_LOG = "sentinel-log"

    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--model", "claude-x"], { from: "user" })

    expect(process.env.FALLBACK_ADVISOR_LOG).toBe("sentinel-log")
  } finally {
    restoreEnv(prev)
  }
})

test("buildProgram: with --log-dir not passed, FALLBACK_ADVISOR_LOG_DIR is left untouched", async () => {
  const prev = snapshotEnv()
  try {
    process.env.FALLBACK_ADVISOR_LOG_DIR = "sentinel-log-dir"

    const program = buildProgram({ onServe: () => {} })
    await program.parseAsync(["--model", "claude-x"], { from: "user" })

    expect(process.env.FALLBACK_ADVISOR_LOG_DIR).toBe("sentinel-log-dir")
  } finally {
    restoreEnv(prev)
  }
})
