import { expect, test } from "bun:test"
import type { AdvisorDeps } from "./advisor"
import { runFallbackAdvisor } from "./advisor"
import { REVIEWER_SYSTEM_PROMPT } from "./prompt"
import type { FallbackAdvisorInput } from "./schema"

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

function makeDeps(opts: {
  sessions: Array<{ sessionId: string; lastModified: number }>
  messagesBySession?: Record<string, FakeSessionMessage[]>
  queryMessages?: FakeMessage[]
  stderrText?: string
  throwOnSession?: (sessionId: string) => Error | undefined
  queryImpl?: (params: FakeQueryParams) => AsyncGenerator<FakeMessage>
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

const baseInput: FallbackAdvisorInput = {
  scope: "session",
}

// ---------------------------------------------------------------------------
// success
// ---------------------------------------------------------------------------

test("success: result.result becomes advice, respondedModel from assistant", async () => {
  const prev = process.env.FALLBACK_ADVISOR_MODEL
  process.env.FALLBACK_ADVISOR_MODEL = "claude-requested"
  try {
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
    // The option keys must be exactly the intended set. This fails if any
    // permission/bypass flag (or any other option) is ever added.
    expect(Object.keys(options).sort()).toEqual([
      "abortController",
      "env",
      "maxTurns",
      "model",
      "persistSession",
      "settingSources",
      "stderr",
      "systemPrompt",
      "tools",
    ])
  } finally {
    if (prev === undefined) delete process.env.FALLBACK_ADVISOR_MODEL
    else process.env.FALLBACK_ADVISOR_MODEL = prev
  }
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

test("no sessions: structured error mentions cwd / CLAUDE_PROJECT_DIR", async () => {
  const { deps } = makeDeps({ sessions: [] })

  const out = await runFallbackAdvisor({ cwd: "/tmp/does-not-matter" }, deps)

  expect(out.isError).toBe(true)
  expect(out.advice).toContain("no sessions found for dir=/tmp/does-not-matter")
  expect(out.advice).toContain("CLAUDE_PROJECT_DIR")
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
