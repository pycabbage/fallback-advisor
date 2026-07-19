import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  type CanUseTool,
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk"
import {
  DEFAULT_MAX_TRANSCRIPT_CHARS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_TURNS_WITH_TOOLS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  envBool,
  envList,
  envNumber,
  loadMcpConfigFiles,
  loadSettingsEnv,
  matchesToolPattern,
  resolveClaudeExecutablePath,
} from "./config"
import { type HistoryDeps, loadTranscript } from "./history"
import type { AdvisorLogger, AdvisorOutcome, LogEndInput } from "./logger"
import { createFileLogger } from "./logger"
import { buildPrompt, REVIEWER_SYSTEM_PROMPT } from "./prompt"
import type {
  FallbackAdvisorInput,
  FallbackAdvisorOutput,
  Scope,
} from "./schema"
import { applyCharBudget, tail, truncate } from "./transcript"

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export type AdvisorDeps = HistoryDeps & {
  query: typeof query
  // Optional: existing tests/deps that omit this field get a no-op logger for
  // free (every call site below uses `deps.logger?.`), so the call-log
  // feature (src/logger.ts) is additive and never required by callers.
  logger?: AdvisorLogger
}

const DEFAULT_DEPS: AdvisorDeps = {
  query,
  listSessions,
  getSessionMessages,
  logger: createFileLogger(),
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function runFallbackAdvisor(
  input: FallbackAdvisorInput,
  deps: AdvisorDeps = DEFAULT_DEPS
): Promise<FallbackAdvisorOutput> {
  // ---------------------------------------------------------------------
  // Call-log bookkeeping (src/logger.ts). `callId` correlates the start/end
  // JSONL records; `ended` makes doLogEnd idempotent so exactly one end
  // record is ever written per call, however this function returns or
  // throws. `scope`/`requestedModel`/`dir` are hoisted above the try block
  // below so the outer catch/finally (the logEnd safety net) can see them
  // even if something throws before the try body finishes computing them.
  // ---------------------------------------------------------------------
  const callId = randomUUID()
  const startTime = performance.now()
  let ended = false
  let sawInit = false
  let timeToFirstSdkMessageMs: number | undefined

  const scope: Scope = input.scope ?? "session"
  const requestedModel = process.env.FALLBACK_ADVISOR_MODEL ?? DEFAULT_MODEL
  const dir =
    input.cwd ??
    process.env.FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR ??
    process.cwd()

  const doLogEnd = (
    partial: Omit<LogEndInput, "callId" | "cwd" | "durationMs">
  ): void => {
    if (ended) return
    ended = true
    deps.logger?.logEnd({
      callId,
      cwd: dir,
      durationMs: performance.now() - startTime,
      ...partial,
    })
  }
  let uncaught: unknown

  try {
    const maxChars = envNumber(
      "FALLBACK_ADVISOR_MAX_CHARS",
      DEFAULT_MAX_TRANSCRIPT_CHARS
    )
    const timeoutMs = envNumber(
      "FALLBACK_ADVISOR_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS
    )

    const allowRead = envBool("FALLBACK_ADVISOR_ALLOW_READ", false)
    const allowWeb = envBool("FALLBACK_ADVISOR_ALLOW_WEB", true)
    const toolNames: string[] = [
      ...(allowRead ? ["Read"] : []),
      ...(allowWeb ? ["WebSearch", "WebFetch"] : []),
    ]

    const mcpConfigPaths = envList("FALLBACK_ADVISOR_MCP_CONFIG")
    const allowToolPatterns = envList("FALLBACK_ADVISOR_ALLOW_TOOL")

    const hasTools =
      toolNames.length > 0 ||
      allowToolPatterns.length > 0 ||
      mcpConfigPaths.length > 0
    const maxTurns = envNumber(
      "FALLBACK_ADVISOR_MAX_TURNS",
      hasTools ? DEFAULT_MAX_TURNS_WITH_TOOLS : DEFAULT_MAX_TURNS
    )
    const canUseTool: CanUseTool = async (toolName) =>
      toolNames.includes(toolName) ||
      allowToolPatterns.some((pattern) => matchesToolPattern(pattern, toolName))
        ? { behavior: "allow" as const }
        : {
            behavior: "deny" as const,
            message: `${toolName} is not enabled for FallbackAdvisor (enable it via FALLBACK_ADVISOR_ALLOW_READ/--allow-read, FALLBACK_ADVISOR_ALLOW_WEB/--allow-web, or FALLBACK_ADVISOR_ALLOW_TOOL/--allow-tool).`,
          }

    // Preflight: the SDK spawns the host Claude Code CLI, which must exist.
    // Passing pathToClaudeCodeExecutable also makes the SDK skip its own
    // import.meta.url resolution (broken in a --compile'd binary). Resolved
    // here (a pure env read) so it is available for the log-start record
    // below; the existsSync check itself stays later, in its original spot.
    const claudePath = resolveClaudeExecutablePath()

    deps.logger?.logStart({
      callId,
      scope,
      cwd: dir,
      contextChars: (input.context ?? "").length,
      config: {
        model: requestedModel,
        timeoutMs,
        maxChars,
        maxTurns,
        allowRead,
        allowWeb,
        mcpConfigPaths,
        allowToolPatterns,
        claudePath,
      },
    })

    const baseError = (
      advice: string,
      notes: string[],
      outcome: AdvisorOutcome,
      counts?: {
        sessionCount?: number
        messageCount?: number
        transcriptChars?: number
      }
    ): FallbackAdvisorOutput => {
      const note = notes.length > 0 ? notes.join(" / ") : undefined
      doLogEnd({
        outcome,
        requestedModel,
        respondedModel: null,
        fallbackOccurred: false,
        sessionCount: counts?.sessionCount ?? 0,
        messageCount: counts?.messageCount ?? 0,
        transcriptChars: counts?.transcriptChars ?? 0,
        adviceChars: advice.length,
        isError: true,
        note,
        sawInit,
        errorMessage: truncate(advice, 1000),
      })
      return {
        advice,
        requestedModel,
        respondedModel: null,
        fallbackOccurred: false,
        scope,
        sessionCount: 0,
        messageCount: 0,
        transcriptChars: 0,
        isError: true,
        note,
      }
    }

    // 1-5. Load and serialize the transcript for the requested scope.
    const loaded = await loadTranscript(deps, dir, scope)
    const notes = [...loaded.notes]

    let mcpServers: ReturnType<typeof loadMcpConfigFiles> | undefined
    if (mcpConfigPaths.length > 0) {
      try {
        mcpServers = loadMcpConfigFiles(mcpConfigPaths)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        return baseError(reason, notes, "mcp_config_error", {
          sessionCount: loaded.sessionCount,
          messageCount: loaded.messageCount,
        })
      }
    }

    if (loaded.sessionsFound === 0) {
      return baseError(
        `no sessions found for dir=${dir} (if the MCP server's cwd differs from the target project, pass input.cwd or set the FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR environment variable)`,
        notes,
        "no_sessions",
        { sessionCount: loaded.sessionCount, messageCount: loaded.messageCount }
      )
    }

    if (loaded.messageCount === 0) {
      return baseError(
        `Could not load any user/assistant messages from the target session(s) (dir=${dir}, scope=${scope})`,
        notes,
        "no_messages",
        { sessionCount: loaded.sessionCount, messageCount: loaded.messageCount }
      )
    }

    const { sessionCount, messageCount } = loaded

    // 6. Enforce the total character budget (prefer the newest content).
    const budgeted = applyCharBudget(loaded.parts.join("\n\n"), maxChars)
    const transcript = budgeted.transcript
    if (budgeted.truncated) {
      notes.push(
        `Transcript exceeded the limit (${maxChars} chars); older history was omitted (original ${budgeted.originalLength} chars)`
      )
    }
    const transcriptChars = transcript.length

    // 8. Assemble the prompt.
    const prompt = buildPrompt(transcript, input.context)

    // 8b. Preflight check proper: the resolved claudePath must actually exist.
    if (!existsSync(claudePath)) {
      return baseError(
        `Claude Code executable not found at ${claudePath}. ` +
          `This MCP server spawns the host Claude Code CLI; set FALLBACK_ADVISOR_CLAUDE_PATH to its location.`,
        notes,
        "claude_path_missing",
        { sessionCount, messageCount, transcriptChars }
      )
    }

    // 9. AbortController with a timeout.
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), timeoutMs)

    const stderrChunks: string[] = []

    // 10. Collection state.
    const assistantTexts: string[] = []
    let lastAssistantModel: string | null = null
    let fallbackOccurred = false
    let fallbackFrom: string | undefined
    let fallbackTo: string | undefined
    let refusalCategory: string | undefined
    let noFallback = false
    let noFallbackCategory: string | undefined
    let noFallbackExplanation: string | undefined
    // biome-ignore lint/suspicious/noExplicitAny: SDK result messages are handled loosely.
    let resultMsg: any = null

    const finalize = (
      advice: string,
      isError: boolean,
      respondedModel: string | null,
      outcome: AdvisorOutcome
    ): FallbackAdvisorOutput => {
      if (stderrChunks.length > 0) {
        const label = isError ? "stderr" : "stderr(informational)"
        notes.push(`${label}: ${tail(stderrChunks.join(""), 800)}`)
      }
      const costUsd =
        resultMsg && typeof resultMsg.total_cost_usd === "number"
          ? resultMsg.total_cost_usd
          : undefined
      const numTurns =
        resultMsg && typeof resultMsg.num_turns === "number"
          ? resultMsg.num_turns
          : undefined
      const note = notes.length > 0 ? notes.join(" / ") : undefined
      doLogEnd({
        outcome,
        requestedModel,
        respondedModel,
        fallbackOccurred,
        fallbackFrom,
        fallbackTo,
        refusalCategory,
        sessionCount,
        messageCount,
        transcriptChars,
        costUsd,
        numTurns,
        adviceChars: advice.length,
        isError,
        note,
        sawInit,
        timeToFirstSdkMessageMs,
        stderrTail:
          isError && stderrChunks.length > 0
            ? tail(stderrChunks.join(""), 2000)
            : undefined,
        errorMessage: isError ? truncate(advice, 1000) : undefined,
      })
      return {
        advice,
        requestedModel,
        respondedModel,
        fallbackOccurred,
        fallbackFrom,
        fallbackTo,
        refusalCategory,
        scope,
        sessionCount,
        messageCount,
        transcriptChars,
        costUsd,
        numTurns,
        note,
        isError,
      }
    }

    const streamStart = performance.now()
    try {
      const response = deps.query({
        prompt,
        options: {
          model: requestedModel,
          systemPrompt: REVIEWER_SYSTEM_PROMPT,
          tools: toolNames,
          maxTurns,
          settingSources: [],
          persistSession: false,
          pathToClaudeCodeExecutable: claudePath,
          cwd: dir,
          // `mcpServers` only registers servers/tools with the model; it does
          // not by itself grant execution permission (that's canUseTool below).
          // Registering a server via FALLBACK_ADVISOR_MCP_CONFIG without any
          // matching FALLBACK_ADVISOR_ALLOW_TOOL pattern still denies every
          // tool call from it.
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          // When no tool is enabled (the default), tools:[] means there is
          // nothing to permission-check, so bypassPermissions and similar are
          // unnecessary and would over-grant a read-only advisor. When a tool
          // IS enabled, canUseTool below resolves every tool-call permission
          // decision itself, synchronously and deterministically (allow only
          // the explicitly enabled tool names, deny everything else), without
          // ever surfacing an interactive permission prompt — this headless,
          // single-shot subprocess has no user to answer one, and per the
          // SDK's own docs permission prompts have no park deadline, so an
          // unresolved one would otherwise hang until timeoutMs aborts it.
          ...(hasTools ? { canUseTool } : {}),
          abortController,
          // Merge whitelisted inference-routing vars from ~/.claude/settings.json
          // first so that process.env (if already populated) takes precedence.
          env: { ...loadSettingsEnv(), ...process.env },
          stderr: (d) => {
            stderrChunks.push(d)
          },
        },
      })

      for await (const message of response) {
        // biome-ignore lint/suspicious/noExplicitAny: SDKMessage is handled loosely.
        const m = message as any
        if (timeToFirstSdkMessageMs === undefined) {
          timeToFirstSdkMessageMs = performance.now() - streamStart
        }
        if (m.type === "system" && m.subtype === "init") {
          sawInit = true
        } else if (m.type === "assistant") {
          const content = m.message?.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "text" && typeof block.text === "string") {
                assistantTexts.push(block.text)
              }
            }
          }
          if (typeof m.message?.model === "string") {
            lastAssistantModel = m.message.model
          }
        } else if (
          m.type === "system" &&
          m.subtype === "model_refusal_fallback"
        ) {
          fallbackOccurred = true
          fallbackFrom = m.original_model
          fallbackTo = m.fallback_model
          refusalCategory = m.api_refusal_category ?? undefined
        } else if (
          m.type === "system" &&
          m.subtype === "model_refusal_no_fallback"
        ) {
          noFallback = true
          noFallbackCategory = m.api_refusal_category ?? undefined
          noFallbackExplanation = m.api_refusal_explanation ?? undefined
        } else if (m.type === "result") {
          resultMsg = m
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        return finalize(
          `The reviewer model timed out (${timeoutMs}ms).`,
          true,
          lastAssistantModel,
          "timeout"
        )
      }
      const reason = err instanceof Error ? err.message : String(err)
      return finalize(
        `An error occurred during inference: ${reason}`,
        true,
        null,
        "exception"
      )
    } finally {
      clearTimeout(timer)
    }

    // 11. Decide the advice.
    // A refusal with no fallback is surfaced explicitly, ahead of success (which
    // may be an empty string).
    if (noFallback) {
      refusalCategory = noFallbackCategory
      let advice = "The model refused and no fallback was available."
      if (noFallbackCategory) advice += ` (category: ${noFallbackCategory})`
      if (noFallbackExplanation) advice += ` ${noFallbackExplanation}`
      return finalize(advice, true, lastAssistantModel, "refusal_no_fallback")
    }
    if (resultMsg && resultMsg.subtype === "success") {
      const respondedModel =
        lastAssistantModel ??
        (fallbackOccurred ? (fallbackTo ?? null) : requestedModel)
      return finalize(
        String(resultMsg.result ?? ""),
        false,
        respondedModel,
        fallbackOccurred ? "success_fallback" : "success"
      )
    }
    if (resultMsg) {
      const errors: unknown = resultMsg.errors
      const advice =
        Array.isArray(errors) && errors.length > 0
          ? errors.map((e) => String(e)).join("\n")
          : `Inference ended with an error (subtype=${String(resultMsg.subtype)})`
      return finalize(advice, true, lastAssistantModel, "result_error")
    }
    if (assistantTexts.length > 0) {
      const respondedModel =
        lastAssistantModel ??
        (fallbackOccurred ? (fallbackTo ?? null) : requestedModel)
      return finalize(
        assistantTexts.join("\n\n"),
        false,
        respondedModel,
        "success_partial"
      )
    }
    return finalize(
      "No response was obtained.",
      true,
      lastAssistantModel,
      "empty"
    )
  } catch (err) {
    // Preserved so the `finally` safety net below can attach errorMessage;
    // rethrown after it runs so callers still see the original failure.
    uncaught = err
    throw err
  } finally {
    // Safety net: guarantee exactly one end record is written even if some
    // code path above threw, or returned without going through
    // baseError/finalize (both of which already call doLogEnd — this is then
    // a no-op, via `ended`). This is the only place that can observe "the
    // whole function is exiting and no end record has been written yet".
    const reason =
      uncaught === undefined
        ? undefined
        : uncaught instanceof Error
          ? uncaught.message
          : String(uncaught)
    doLogEnd({
      outcome: "exception",
      requestedModel,
      respondedModel: null,
      fallbackOccurred: false,
      sessionCount: 0,
      messageCount: 0,
      transcriptChars: 0,
      adviceChars: 0,
      isError: true,
      sawInit,
      errorMessage: reason === undefined ? undefined : truncate(reason, 1000),
    })
  }
}
