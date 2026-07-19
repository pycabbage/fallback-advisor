import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AdvisorDeps } from "./advisor"
import { runFallbackAdvisor } from "./advisor"
import { REVIEWER_SYSTEM_PROMPT } from "./prompt"
import type { FallbackAdvisorInput } from "./schema"

// ---------------------------------------------------------------------------
// Claude executable preflight: point it at a path that definitely exists
// (the running interpreter) so tests reach query(); restore per test.
// ---------------------------------------------------------------------------

let prevClaudePath: string | undefined

beforeEach(() => {
  prevClaudePath = process.env.FALLBACK_ADVISOR_CLAUDE_PATH
  process.env.FALLBACK_ADVISOR_CLAUDE_PATH = process.execPath
})

afterEach(() => {
  if (prevClaudePath === undefined)
    delete process.env.FALLBACK_ADVISOR_CLAUDE_PATH
  else process.env.FALLBACK_ADVISOR_CLAUDE_PATH = prevClaudePath
})

// ---------------------------------------------------------------------------
// Fake dependency helpers
// ---------------------------------------------------------------------------

type FakeOptions = { stderr?: (d: string) => void } & Record<string, unknown>
type FakeQueryParams = { prompt: string; options: FakeOptions }
type FakeMessage = Record<string, unknown>
type FakeSessionMessage = { type: string; message?: unknown }

async function* streamOf(items: FakeMessage[]): AsyncGenerator<FakeMessage> {
  for (const item of items) yield item
}

// biome-ignore lint/suspicious/noExplicitAny: log records are handled loosely in tests.
type FakeLogRecord = Record<string, any>

function makeFakeLogger() {
  const startCalls: FakeLogRecord[] = []
  const endCalls: FakeLogRecord[] = []
  return {
    logger: {
      logStart: (rec: FakeLogRecord) => startCalls.push(rec),
      logEnd: (rec: FakeLogRecord) => endCalls.push(rec),
    },
    startCalls,
    endCalls,
  }
}

function makeDeps(opts: {
  sessions: Array<{ sessionId: string; lastModified: number }>
  messagesBySession?: Record<string, FakeSessionMessage[]>
  queryMessages?: FakeMessage[]
  stderrText?: string
  throwOnSession?: (sessionId: string) => Error | undefined
  queryImpl?: (params: FakeQueryParams) => AsyncGenerator<FakeMessage>
  // biome-ignore lint/suspicious/noExplicitAny: fake logger shape mirrors AdvisorLogger loosely in tests.
  logger?: any
}) {
  const getSessionCalls: string[] = []
  let capturedParams: FakeQueryParams | null = null

  const deps = {
    listSessions: async () =>
      opts.sessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.sessionId,
        lastModified: s.lastModified,
      })),
    getSessionMessages: async (sessionId: string) => {
      getSessionCalls.push(sessionId)
      const thrown = opts.throwOnSession?.(sessionId)
      if (thrown) throw thrown
      return opts.messagesBySession?.[sessionId] ?? []
    },
    query: (params: FakeQueryParams) => {
      capturedParams = params
      if (opts.stderrText !== undefined) {
        params.options?.stderr?.(opts.stderrText)
      }
      if (opts.queryImpl) return opts.queryImpl(params)
      return streamOf(opts.queryMessages ?? [])
    },
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  } as unknown as AdvisorDeps

  return {
    deps,
    getSessionCalls,
    getCapturedParams: (): FakeQueryParams | null => capturedParams,
  }
}

function userMsg(text: string): FakeSessionMessage {
  return { type: "user", message: { content: text } }
}

// Temporarily set (or delete, for `undefined`) each env var in `overrides`,
// run `fn`, then restore every var to its prior value.
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const prev: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await fn()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const baseInput: FallbackAdvisorInput = {
  scope: "session",
}

// ---------------------------------------------------------------------------
// success
// ---------------------------------------------------------------------------

test("success: result.result becomes advice, respondedModel from assistant", async () => {
  await withEnv(
    {
      FALLBACK_ADVISOR_MODEL: "claude-requested",
      // FALLBACK_ADVISOR_ALLOW_WEB now defaults to true; force it off here so
      // this test exercises the fully-disabled path (tools:[], maxTurns:1, no
      // canUseTool) that its assertions below depend on.
      FALLBACK_ADVISOR_ALLOW_WEB: "false",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("do the thing")] },
        queryMessages: [
          {
            type: "assistant",
            message: {
              model: "claude-responder",
              content: [{ type: "text", text: "partial text" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "final advice",
            total_cost_usd: 0.01,
            num_turns: 1,
          },
        ],
        stderrText: "informational warning line",
      })

      const out = await runFallbackAdvisor(baseInput, deps)

      expect(out.isError).toBe(false)
      expect(out.advice).toBe("final advice")
      expect(out.requestedModel).toBe("claude-requested")
      expect(out.respondedModel).toBe("claude-responder")
      expect(out.fallbackOccurred).toBe(false)
      expect(out.costUsd).toBe(0.01)
      expect(out.numTurns).toBe(1)
      expect(out.messageCount).toBe(1)
      expect(out.sessionCount).toBe(1)

      // Behavior #6: stderr is attached as an informational note even on success.
      expect(out.note).toContain("stderr(informational)")
      expect(out.note).toContain("informational warning line")

      // Behavior #2 / #7: query options are exactly the intended set.
      const params = getCapturedParams()
      expect(params).not.toBeNull()
      const options = params?.options as FakeOptions
      expect(options.tools).toEqual([])
      expect(options.maxTurns).toBe(1)
      expect(options.settingSources).toEqual([])
      expect(options.persistSession).toBe(false)
      expect(options.model).toBe("claude-requested")
      expect(options.systemPrompt).toBe(REVIEWER_SYSTEM_PROMPT)
      // The SDK is pointed at the resolved host Claude Code executable.
      expect(options.pathToClaudeCodeExecutable).toBe(process.execPath)
      // No tool is enabled by default: tools stays empty and maxTurns stays 1.
      expect(options.tools).toEqual([])
      expect(options.maxTurns).toBe(1)
      expect(options.cwd).toBe(process.cwd())
      // The option keys must be exactly the intended set. This fails if any
      // permission/bypass flag (or any other option) is ever added.
      expect(Object.keys(options).sort()).toEqual([
        "abortController",
        "cwd",
        "env",
        "maxTurns",
        "model",
        "pathToClaudeCodeExecutable",
        "persistSession",
        "settingSources",
        "stderr",
        "systemPrompt",
        "tools",
      ])
    }
  )
})

// ---------------------------------------------------------------------------
// opt-in tools: Read / Web / maxTurns
// ---------------------------------------------------------------------------

type FakeCanUseTool = (
  toolName: string,
  input: unknown,
  options: unknown
) => Promise<{ behavior: string; message?: string }>

test("FALLBACK_ADVISOR_ALLOW_READ=1: tools=['Read'], maxTurns=10, canUseTool allows Read / denies others", async () => {
  await withEnv(
    {
      FALLBACK_ADVISOR_ALLOW_READ: "1",
      // FALLBACK_ADVISOR_ALLOW_WEB now defaults to true; force it off so this
      // test isolates ALLOW_READ's effect (tools stays exactly ['Read']).
      FALLBACK_ADVISOR_ALLOW_WEB: "false",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      expect(options.tools).toEqual(["Read"])
      expect(options.maxTurns).toBe(10)
      expect(typeof options.canUseTool).toBe("function")

      const canUseTool = options.canUseTool as FakeCanUseTool
      const allowed = await canUseTool("Read", {}, {} as never)
      expect(allowed).toEqual({ behavior: "allow" })

      const denied = await canUseTool("Bash", {}, {} as never)
      expect(denied.behavior).toBe("deny")
      expect(typeof denied.message).toBe("string")
      expect((denied.message ?? "").length).toBeGreaterThan(0)

      // The option keys must be exactly the intended set for the tools-enabled
      // path too: canUseTool is the only addition over the no-tools baseline,
      // and no other permission/bypass flag (e.g. allowedTools,
      // bypassPermissions, permissionMode) is ever introduced alongside it.
      expect(Object.keys(options).sort()).toEqual([
        "abortController",
        "canUseTool",
        "cwd",
        "env",
        "maxTurns",
        "model",
        "pathToClaudeCodeExecutable",
        "persistSession",
        "settingSources",
        "stderr",
        "systemPrompt",
        "tools",
      ])
    }
  )
})

test("FALLBACK_ADVISOR_ALLOW_WEB=1: tools=['WebSearch','WebFetch']", async () => {
  await withEnv({ FALLBACK_ADVISOR_ALLOW_WEB: "1" }, async () => {
    const { deps, getCapturedParams } = makeDeps({
      sessions: [{ sessionId: "s1", lastModified: 100 }],
      messagesBySession: { s1: [userMsg("task")] },
      queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
    })

    await runFallbackAdvisor(baseInput, deps)

    const options = getCapturedParams()?.options as FakeOptions
    expect(options.tools).toEqual(["WebSearch", "WebFetch"])
  })
})

test("default (neither ALLOW_READ nor ALLOW_WEB set): Web tools are on by default, Read stays off", async () => {
  // Force the true "neither set" state regardless of ambient shell/CI env.
  await withEnv(
    {
      FALLBACK_ADVISOR_ALLOW_READ: undefined,
      FALLBACK_ADVISOR_ALLOW_WEB: undefined,
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      expect(options.tools).toEqual(["WebSearch", "WebFetch"])
      expect(options.maxTurns).toBe(10)
      expect(typeof options.canUseTool).toBe("function")

      const canUseTool = options.canUseTool as FakeCanUseTool
      expect(await canUseTool("WebSearch", {}, {} as never)).toEqual({
        behavior: "allow",
      })
      expect(await canUseTool("WebFetch", {}, {} as never)).toEqual({
        behavior: "allow",
      })
      const denied = await canUseTool("Read", {}, {} as never)
      expect(denied.behavior).toBe("deny")
    }
  )
})

test("FALLBACK_ADVISOR_MAX_TURNS explicit override wins over the tools-enabled default of 10", async () => {
  await withEnv(
    {
      FALLBACK_ADVISOR_ALLOW_READ: "1",
      FALLBACK_ADVISOR_MAX_TURNS: "3",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      expect(options.maxTurns).toBe(3)
    }
  )
})

// ---------------------------------------------------------------------------
// opt-in MCP servers: --mcp-config / --allow-tool
// ---------------------------------------------------------------------------

let mcpTmpDir: string

beforeEach(() => {
  mcpTmpDir = join(
    tmpdir(),
    `fallback-advisor-mcp-test-${Date.now()}-${Math.random()}`
  )
  mkdirSync(mcpTmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(mcpTmpDir, { recursive: true, force: true })
})

function writeMcpConfig(mcpServers: Record<string, unknown>): string {
  const p = join(mcpTmpDir, "mcp.json")
  writeFileSync(p, JSON.stringify({ mcpServers }), "utf8")
  return p
}

test("no FALLBACK_ADVISOR_MCP_CONFIG: mcpServers is not passed to query()", async () => {
  await withEnv(
    {
      FALLBACK_ADVISOR_MCP_CONFIG: undefined,
      FALLBACK_ADVISOR_ALLOW_WEB: "false",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      expect(options.mcpServers).toBeUndefined()
      expect("mcpServers" in options).toBe(false)
    }
  )
})

test("FALLBACK_ADVISOR_MCP_CONFIG: mcpServers is loaded and passed through, maxTurns rises to 10, canUseTool denies by default", async () => {
  const configPath = writeMcpConfig({
    brave: { command: "bunx", args: ["brave-mcp"] },
  })

  await withEnv(
    {
      FALLBACK_ADVISOR_MCP_CONFIG: configPath,
      FALLBACK_ADVISOR_ALLOW_WEB: "false",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      expect(options.mcpServers).toEqual({
        brave: { command: "bunx", args: ["brave-mcp"] },
      })
      expect(options.maxTurns).toBe(10)

      const canUseTool = options.canUseTool as FakeCanUseTool
      const denied = await canUseTool(
        "mcp__brave__brave_web_search",
        {},
        {} as never
      )
      expect(denied.behavior).toBe("deny")
    }
  )
})

test("FALLBACK_ADVISOR_ALLOW_TOOL: a matching glob pattern allows the tool, others still denied", async () => {
  const configPath = writeMcpConfig({
    brave: { command: "bunx", args: ["brave-mcp"] },
  })

  await withEnv(
    {
      FALLBACK_ADVISOR_MCP_CONFIG: configPath,
      FALLBACK_ADVISOR_ALLOW_TOOL: "mcp__brave__*",
      FALLBACK_ADVISOR_ALLOW_WEB: "false",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      const canUseTool = options.canUseTool as FakeCanUseTool

      const allowed = await canUseTool(
        "mcp__brave__brave_web_search",
        {},
        {} as never
      )
      expect(allowed).toEqual({ behavior: "allow" })

      const denied = await canUseTool("mcp__tavily__search", {}, {} as never)
      expect(denied.behavior).toBe("deny")
    }
  )
})

test("FALLBACK_ADVISOR_ALLOW_TOOL alone (no --mcp-config): still enables canUseTool/maxTurns and can allow a tool name", async () => {
  await withEnv(
    {
      FALLBACK_ADVISOR_MCP_CONFIG: undefined,
      FALLBACK_ADVISOR_ALLOW_TOOL: "mcp__brave__brave_web_search",
      FALLBACK_ADVISOR_ALLOW_WEB: "false",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      expect(options.mcpServers).toBeUndefined()
      expect(options.maxTurns).toBe(10)

      const canUseTool = options.canUseTool as FakeCanUseTool
      const allowed = await canUseTool(
        "mcp__brave__brave_web_search",
        {},
        {} as never
      )
      expect(allowed).toEqual({ behavior: "allow" })
    }
  )
})

test("FALLBACK_ADVISOR_MCP_CONFIG pointing at a missing file: structured error before query, mcpServers never reaches query()", async () => {
  let queryCalled = false
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryImpl: () => {
      queryCalled = true
      throw new Error("query must not be called when MCP config loading fails")
    },
  })

  await withEnv(
    {
      FALLBACK_ADVISOR_MCP_CONFIG: join(
        mcpTmpDir,
        "nonexistent-mcp-config.json"
      ),
    },
    async () => {
      const out = await runFallbackAdvisor(baseInput, deps)

      expect(out.isError).toBe(true)
      expect(out.advice).toContain("Failed to read MCP config file")
      expect(queryCalled).toBe(false)
    }
  )
})

test("FALLBACK_ADVISOR_MCP_CONFIG with multiple files (space-separated): later file wins on collision", async () => {
  const a = writeMcpConfig({ brave: { command: "a" } })
  const bPath = join(mcpTmpDir, "b.json")
  writeFileSync(
    bPath,
    JSON.stringify({ mcpServers: { brave: { command: "b" } } }),
    "utf8"
  )

  await withEnv(
    {
      FALLBACK_ADVISOR_MCP_CONFIG: `${a} ${bPath}`,
      FALLBACK_ADVISOR_ALLOW_WEB: "false",
    },
    async () => {
      const { deps, getCapturedParams } = makeDeps({
        sessions: [{ sessionId: "s1", lastModified: 100 }],
        messagesBySession: { s1: [userMsg("task")] },
        queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
      })

      await runFallbackAdvisor(baseInput, deps)

      const options = getCapturedParams()?.options as FakeOptions
      expect(options.mcpServers).toEqual({ brave: { command: "b" } })
    }
  )
})

// ---------------------------------------------------------------------------
// claude executable preflight
// ---------------------------------------------------------------------------

test("preflight: a missing claude executable returns a structured error before query", async () => {
  let queryCalled = false
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryImpl: () => {
      queryCalled = true
      throw new Error("query must not be called when the preflight fails")
    },
  })

  process.env.FALLBACK_ADVISOR_CLAUDE_PATH =
    "/nonexistent/path/claude-does-not-exist-12345"

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toContain("FALLBACK_ADVISOR_CLAUDE_PATH")
  expect(out.advice).toContain("/nonexistent/path/claude-does-not-exist-12345")
  // The preflight must short-circuit before the SDK is ever invoked.
  expect(queryCalled).toBe(false)
})

// ---------------------------------------------------------------------------
// refusal -> fallback
// ---------------------------------------------------------------------------

test("refusal -> fallback: reports fallback metadata and completes", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      {
        type: "system",
        subtype: "model_refusal_fallback",
        original_model: "claude-fable-5",
        fallback_model: "claude-strong",
        api_refusal_category: "policy",
      },
      {
        type: "assistant",
        message: {
          model: "claude-strong",
          content: [{ type: "text", text: "reviewed" }],
        },
      },
      { type: "result", subtype: "success", result: "fallback advice" },
    ],
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(false)
  expect(out.advice).toBe("fallback advice")
  expect(out.fallbackOccurred).toBe(true)
  expect(out.fallbackFrom).toBe("claude-fable-5")
  expect(out.fallbackTo).toBe("claude-strong")
  expect(out.refusalCategory).toBe("policy")
  expect(out.respondedModel).toBe("claude-strong")
})

// ---------------------------------------------------------------------------
// refusal -> no fallback
// ---------------------------------------------------------------------------

test("refusal -> no fallback: isError and refusalCategory is set", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      {
        type: "system",
        subtype: "model_refusal_no_fallback",
        api_refusal_category: "policy",
        api_refusal_explanation: "cannot help with this",
      },
    ],
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.refusalCategory).toBe("policy")
  expect(out.advice).toContain(
    "The model refused and no fallback was available."
  )
  expect(out.advice).toContain("(category: policy)")
  expect(out.advice).toContain("cannot help with this")
})

// ---------------------------------------------------------------------------
// result error
// ---------------------------------------------------------------------------

test("result error: errors become advice, isError true", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["boom", "bang"],
      },
    ],
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toBe("boom\nbang")
})

// ---------------------------------------------------------------------------
// assistant text only (no result message)
// ---------------------------------------------------------------------------

test("assistant text only: concatenated text becomes advice, isError false", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      {
        type: "assistant",
        message: {
          model: "claude-x",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      },
    ],
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(false)
  expect(out.advice).toBe("a\n\nb")
  expect(out.respondedModel).toBe("claude-x")
})

// ---------------------------------------------------------------------------
// scope selection
// ---------------------------------------------------------------------------

test("scope session: only the most recently modified session is used", async () => {
  const { deps, getSessionCalls, getCapturedParams } = makeDeps({
    sessions: [
      { sessionId: "old", lastModified: 100 },
      { sessionId: "new", lastModified: 200 },
    ],
    messagesBySession: {
      old: [userMsg("OLD CONTENT")],
      new: [userMsg("NEW CONTENT")],
    },
    queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
  })

  const out = await runFallbackAdvisor({ scope: "session" }, deps)

  expect(getSessionCalls).toEqual(["new"])
  expect(out.sessionCount).toBe(1)
  expect(out.messageCount).toBe(1)
  const prompt = getCapturedParams()?.prompt ?? ""
  expect(prompt).toContain("NEW CONTENT")
  expect(prompt).not.toContain("OLD CONTENT")
})

test("scope project: all sessions concatenated oldest-first", async () => {
  const { deps, getSessionCalls, getCapturedParams } = makeDeps({
    sessions: [
      { sessionId: "new", lastModified: 200 },
      { sessionId: "old", lastModified: 100 },
    ],
    messagesBySession: {
      old: [userMsg("OLD CONTENT")],
      new: [userMsg("NEW CONTENT")],
    },
    queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
  })

  const out = await runFallbackAdvisor({ scope: "project" }, deps)

  expect(getSessionCalls).toEqual(["old", "new"])
  expect(out.sessionCount).toBe(2)
  expect(out.messageCount).toBe(2)
  const prompt = getCapturedParams()?.prompt ?? ""
  expect(prompt.indexOf("OLD CONTENT")).toBeLessThan(
    prompt.indexOf("NEW CONTENT")
  )
})

// ---------------------------------------------------------------------------
// no sessions (behavior #5)
// ---------------------------------------------------------------------------

test("no sessions: structured error mentions cwd / FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR", async () => {
  const { deps } = makeDeps({ sessions: [] })

  const out = await runFallbackAdvisor({ cwd: "/tmp/does-not-matter" }, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toContain("no sessions found for dir=/tmp/does-not-matter")
  expect(out.advice).toContain("FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR")
})

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

test("timeout: aborted query yields the timeout advice and isError", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryImpl: (params) => {
      const ac = params.options.abortController as AbortController
      ac.abort()
      throw new Error("The operation was aborted")
    },
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.advice.startsWith("The reviewer model timed out")).toBe(true)
})

// ---------------------------------------------------------------------------
// generic inference error
// ---------------------------------------------------------------------------

test("generic inference error: reason is surfaced, respondedModel null", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryImpl: () => {
      throw new Error("network exploded")
    },
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toContain("An error occurred during inference:")
  expect(out.advice).toContain("network exploded")
  expect(out.respondedModel).toBeNull()
})

// ---------------------------------------------------------------------------
// no user/assistant messages
// ---------------------------------------------------------------------------

test("no messages: sessions found but nothing serializable -> structured error", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: {
      s1: [{ type: "system", message: { content: "boot" } }],
    },
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toContain("Could not load any user/assistant messages")
})

// ---------------------------------------------------------------------------
// truncation note
// ---------------------------------------------------------------------------

test("truncation note: an over-budget transcript is trimmed with a note", async () => {
  const prev = process.env.FALLBACK_ADVISOR_MAX_CHARS
  process.env.FALLBACK_ADVISOR_MAX_CHARS = "200"
  try {
    const { deps } = makeDeps({
      sessions: [{ sessionId: "s1", lastModified: 100 }],
      messagesBySession: { s1: [userMsg("x".repeat(1000))] },
      queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
    })

    const out = await runFallbackAdvisor(baseInput, deps)

    expect(out.isError).toBe(false)
    expect(out.note ?? "").toContain("older history was omitted")
    expect(out.transcriptChars).toBeLessThanOrEqual(200)
  } finally {
    if (prev === undefined) delete process.env.FALLBACK_ADVISOR_MAX_CHARS
    else process.env.FALLBACK_ADVISOR_MAX_CHARS = prev
  }
})

// ---------------------------------------------------------------------------
// session-skip note
// ---------------------------------------------------------------------------

test("session-skip note: a failing session is skipped and the run still succeeds", async () => {
  const { deps, getCapturedParams } = makeDeps({
    sessions: [
      { sessionId: "good", lastModified: 100 },
      { sessionId: "bad", lastModified: 200 },
    ],
    messagesBySession: { good: [userMsg("GOOD CONTENT")] },
    throwOnSession: (id) => (id === "bad" ? new Error("corrupt") : undefined),
    queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
  })

  const out = await runFallbackAdvisor({ scope: "project" }, deps)

  expect(out.isError).toBe(false)
  expect(out.note ?? "").toContain("Skipped session")
  expect(out.note).toContain("bad")
  expect(out.sessionCount).toBe(1)
  expect(out.messageCount).toBe(1)
  const prompt = getCapturedParams()?.prompt ?? ""
  expect(prompt).toContain("GOOD CONTENT")
})

// ---------------------------------------------------------------------------
// no response
// ---------------------------------------------------------------------------

test("no response: an empty stream yields the no-response advice", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [],
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toBe("No response was obtained.")
})

// ---------------------------------------------------------------------------
// result error without an errors array
// ---------------------------------------------------------------------------

test("result error without errors array: the subtype is surfaced", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [{ type: "result", subtype: "error_max_turns" }],
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toContain(
    "Inference ended with an error (subtype=error_max_turns)"
  )
})

// ---------------------------------------------------------------------------
// call log (src/logger.ts): logStart/logEnd are invoked exactly once each,
// with the outcome matching the FallbackAdvisorOutput for representative
// paths. The fake logger here is a plain spy injected via deps, independent
// of FALLBACK_ADVISOR_LOG/_LOG_DIR (no real file I/O in this file).
// ---------------------------------------------------------------------------

test("call log: success path logs one start and one end with outcome=success", async () => {
  const { logger, startCalls, endCalls } = makeFakeLogger()
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", result: "ok" },
    ],
    logger,
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(false)
  expect(startCalls.length).toBe(1)
  expect(endCalls.length).toBe(1)
  expect(startCalls[0]?.callId).toBe(endCalls[0]?.callId)
  expect(typeof startCalls[0]?.callId).toBe("string")
  expect(endCalls[0]?.outcome).toBe("success")
  expect(endCalls[0]?.isError).toBe(false)
  expect(endCalls[0]?.sawInit).toBe(true)
  expect(typeof endCalls[0]?.durationMs).toBe("number")
})

test("call log: refusal -> fallback logs outcome=success_fallback", async () => {
  const { logger, endCalls } = makeFakeLogger()
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      {
        type: "system",
        subtype: "model_refusal_fallback",
        original_model: "claude-fable-5",
        fallback_model: "claude-strong",
        api_refusal_category: "policy",
      },
      { type: "result", subtype: "success", result: "fallback advice" },
    ],
    logger,
  })

  await runFallbackAdvisor(baseInput, deps)

  expect(endCalls.length).toBe(1)
  expect(endCalls[0]?.outcome).toBe("success_fallback")
})

test("call log: assistant-text-only (no result message) logs outcome=success_partial", async () => {
  const { logger, endCalls } = makeFakeLogger()
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      {
        type: "assistant",
        message: { model: "claude-x", content: [{ type: "text", text: "a" }] },
      },
    ],
    logger,
  })

  await runFallbackAdvisor(baseInput, deps)

  expect(endCalls.length).toBe(1)
  expect(endCalls[0]?.outcome).toBe("success_partial")
})

test("call log: timeout logs outcome=timeout with sawInit false and no logStart-skip", async () => {
  const { logger, startCalls, endCalls } = makeFakeLogger()
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryImpl: (params) => {
      const ac = params.options.abortController as AbortController
      ac.abort()
      throw new Error("The operation was aborted")
    },
    logger,
  })

  const out = await runFallbackAdvisor(baseInput, deps)

  expect(out.isError).toBe(true)
  expect(startCalls.length).toBe(1)
  expect(endCalls.length).toBe(1)
  expect(endCalls[0]?.outcome).toBe("timeout")
  expect(endCalls[0]?.isError).toBe(true)
})

test("call log: no sessions logs outcome=no_sessions without ever calling logStart's config claudePath check", async () => {
  const { logger, startCalls, endCalls } = makeFakeLogger()
  const { deps } = makeDeps({ sessions: [], logger })

  const out = await runFallbackAdvisor({ cwd: "/tmp/does-not-matter" }, deps)

  expect(out.isError).toBe(true)
  expect(startCalls.length).toBe(1)
  expect(endCalls.length).toBe(1)
  expect(endCalls[0]?.outcome).toBe("no_sessions")
  expect(endCalls[0]?.isError).toBe(true)
})

test("call log: a missing claude executable logs outcome=claude_path_missing", async () => {
  const { logger, startCalls, endCalls } = makeFakeLogger()
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    logger,
  })

  const prev = process.env.FALLBACK_ADVISOR_CLAUDE_PATH
  process.env.FALLBACK_ADVISOR_CLAUDE_PATH =
    "/nonexistent/path/claude-does-not-exist-12345"
  try {
    const out = await runFallbackAdvisor(baseInput, deps)

    expect(out.isError).toBe(true)
    expect(startCalls.length).toBe(1)
    expect(endCalls.length).toBe(1)
    expect(endCalls[0]?.outcome).toBe("claude_path_missing")
  } finally {
    if (prev === undefined) delete process.env.FALLBACK_ADVISOR_CLAUDE_PATH
    else process.env.FALLBACK_ADVISOR_CLAUDE_PATH = prev
  }
})

test("call log: refusal with no fallback logs outcome=refusal_no_fallback", async () => {
  const { logger, endCalls } = makeFakeLogger()
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [
      {
        type: "system",
        subtype: "model_refusal_no_fallback",
        api_refusal_category: "policy",
      },
    ],
    logger,
  })

  await runFallbackAdvisor(baseInput, deps)

  expect(endCalls.length).toBe(1)
  expect(endCalls[0]?.outcome).toBe("refusal_no_fallback")
  expect(endCalls[0]?.isError).toBe(true)
})

test("call log: no logger in deps (default AdvisorDeps.logger undefined) does not throw", async () => {
  const { deps } = makeDeps({
    sessions: [{ sessionId: "s1", lastModified: 100 }],
    messagesBySession: { s1: [userMsg("task")] },
    queryMessages: [{ type: "result", subtype: "success", result: "ok" }],
  })

  // No `logger` passed to makeDeps: AdvisorDeps.logger stays undefined, so
  // every deps.logger?.logStart/logEnd call is a no-op, and runFallbackAdvisor
  // must not throw or otherwise behave differently.
  const out = await runFallbackAdvisor(baseInput, deps)
  expect(out.isError).toBe(false)
})
