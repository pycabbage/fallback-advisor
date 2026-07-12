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
  envNumber,
  resolveClaudeExecutablePath,
} from "./config"
import { type HistoryDeps, loadTranscript } from "./history"
import { buildPrompt, REVIEWER_SYSTEM_PROMPT } from "./prompt"
import type {
  FallbackAdvisorInput,
  FallbackAdvisorOutput,
  Scope,
} from "./schema"
import { applyCharBudget, tail } from "./transcript"

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export type AdvisorDeps = HistoryDeps & {
  query: typeof query
}

const DEFAULT_DEPS: AdvisorDeps = {
  query,
  listSessions,
  getSessionMessages,
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function runFallbackAdvisor(
  input: FallbackAdvisorInput,
  deps: AdvisorDeps = DEFAULT_DEPS
): Promise<FallbackAdvisorOutput> {
  const scope: Scope = input.scope ?? "session"
  const requestedModel = process.env.FALLBACK_ADVISOR_MODEL ?? DEFAULT_MODEL
  const dir =
    input.cwd ??
    process.env.FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR ??
    process.cwd()

  const maxChars = envNumber(
    "FALLBACK_ADVISOR_MAX_CHARS",
    DEFAULT_MAX_TRANSCRIPT_CHARS
  )
  const timeoutMs = envNumber("FALLBACK_ADVISOR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)

  const allowRead = envBool("FALLBACK_ADVISOR_ALLOW_READ", false)
  const allowWeb = envBool("FALLBACK_ADVISOR_ALLOW_WEB", true)
  const toolNames: string[] = [
    ...(allowRead ? ["Read"] : []),
    ...(allowWeb ? ["WebSearch", "WebFetch"] : []),
  ]
  const maxTurns = envNumber(
    "FALLBACK_ADVISOR_MAX_TURNS",
    toolNames.length > 0 ? DEFAULT_MAX_TURNS_WITH_TOOLS : DEFAULT_MAX_TURNS
  )
  const canUseTool: CanUseTool | undefined =
    toolNames.length > 0
      ? async (toolName) =>
          toolNames.includes(toolName)
            ? { behavior: "allow" as const }
            : {
                behavior: "deny" as const,
                message: `${toolName} is not enabled for FallbackAdvisor (enable it via FALLBACK_ADVISOR_ALLOW_READ/--allow-read or FALLBACK_ADVISOR_ALLOW_WEB/--allow-web).`,
              }
      : undefined

  const baseError = (
    advice: string,
    notes: string[]
  ): FallbackAdvisorOutput => ({
    advice,
    requestedModel,
    respondedModel: null,
    fallbackOccurred: false,
    scope,
    sessionCount: 0,
    messageCount: 0,
    transcriptChars: 0,
    isError: true,
    note: notes.length > 0 ? notes.join(" / ") : undefined,
  })

  // 1-5. Load and serialize the transcript for the requested scope.
  const loaded = await loadTranscript(deps, dir, scope)
  const notes = [...loaded.notes]

  if (loaded.sessionsFound === 0) {
    return baseError(
      `no sessions found for dir=${dir} (if the MCP server's cwd differs from the target project, pass input.cwd or set the FALLBACK_ADVISOR_CLAUDE_PROJECT_DIR environment variable)`,
      notes
    )
  }

  if (loaded.messageCount === 0) {
    return baseError(
      `Could not load any user/assistant messages from the target session(s) (dir=${dir}, scope=${scope})`,
      notes
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

  // 8b. Preflight: the SDK spawns the host Claude Code CLI, which must exist.
  // Passing pathToClaudeCodeExecutable also makes the SDK skip its own
  // import.meta.url resolution (broken in a --compile'd binary).
  const claudePath = resolveClaudeExecutablePath()
  if (!existsSync(claudePath)) {
    return baseError(
      `Claude Code executable not found at ${claudePath}. ` +
        `This MCP server spawns the host Claude Code CLI; set FALLBACK_ADVISOR_CLAUDE_PATH to its location.`,
      notes
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
    respondedModel: string | null
  ): FallbackAdvisorOutput => {
    if (stderrChunks.length > 0) {
      const label = isError ? "stderr" : "stderr(informational)"
      notes.push(`${label}: ${tail(stderrChunks.join(""), 800)}`)
    }
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
      costUsd:
        resultMsg && typeof resultMsg.total_cost_usd === "number"
          ? resultMsg.total_cost_usd
          : undefined,
      numTurns:
        resultMsg && typeof resultMsg.num_turns === "number"
          ? resultMsg.num_turns
          : undefined,
      note: notes.length > 0 ? notes.join(" / ") : undefined,
      isError,
    }
  }

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
        ...(canUseTool ? { canUseTool } : {}),
        abortController,
        env: { ...process.env },
        stderr: (d) => {
          stderrChunks.push(d)
        },
      },
    })

    for await (const message of response) {
      // biome-ignore lint/suspicious/noExplicitAny: SDKMessage is handled loosely.
      const m = message as any
      if (m.type === "assistant") {
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
        lastAssistantModel
      )
    }
    const reason = err instanceof Error ? err.message : String(err)
    return finalize(`An error occurred during inference: ${reason}`, true, null)
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
    return finalize(advice, true, lastAssistantModel)
  }
  if (resultMsg && resultMsg.subtype === "success") {
    const respondedModel =
      lastAssistantModel ??
      (fallbackOccurred ? (fallbackTo ?? null) : requestedModel)
    return finalize(String(resultMsg.result ?? ""), false, respondedModel)
  }
  if (resultMsg) {
    const errors: unknown = resultMsg.errors
    const advice =
      Array.isArray(errors) && errors.length > 0
        ? errors.map((e) => String(e)).join("\n")
        : `Inference ended with an error (subtype=${String(resultMsg.subtype)})`
    return finalize(advice, true, lastAssistantModel)
  }
  if (assistantTexts.length > 0) {
    const respondedModel =
      lastAssistantModel ??
      (fallbackOccurred ? (fallbackTo ?? null) : requestedModel)
    return finalize(assistantTexts.join("\n\n"), false, respondedModel)
  }
  return finalize("No response was obtained.", true, lastAssistantModel)
}
