import {
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Constants (env-overridable)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-fable-5"
const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000
const DEFAULT_TIMEOUT_MS = 300_000
const BLOCK_TRUNCATE_CHARS = 1500
const OMIT_MARKER = "[... 古い履歴を省略 ...]\n\n"

/**
 * レビュアーに渡すシステムプロンプト。
 * ここには安全機構を無効化・抑制・迂回するような指示は一切含めない。
 * モデルの拒否は拒否として尊重し、透過的に報告する。
 */
const REVIEWER_SYSTEM_PROMPT =
  "あなたは、あるAIコーディングエージェントから相談を受ける、より強力なレビュアーです。以下にそのエージェントの会話トランスクリプト全体（タスク、ツール呼び出しとその結果、推論）が渡されます。あなたの役割は、セカンドオピニオンとして率直で具体的な助言を返すことです。\n\n- 誤った前提、見落とし、より良いアプローチ、リスクを、優先度順に指摘してください。\n- 世辞や冗長な要約は不要。高信号な指摘に集中してください。\n- 不確実な点は確信度を添えてください。\n- あなたは助言を返すだけで、ツールの実行やファイル操作は行いません。"

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const zFallbackAdvisorInput = z.object({
  context: z
    .string()
    .optional()
    .describe("レビュアーへの追加指示や質問。プロンプト末尾に結合される。"),
  model: z
    .string()
    .optional()
    .describe(
      `レビュアーモデル。既定は環境変数 FALLBACK_ADVISOR_MODEL、なければ "${DEFAULT_MODEL}"。`
    ),
  scope: z
    .enum(["session", "project"])
    .optional()
    .describe(
      '"session"(既定)=現在の会話全体。"project"=当該プロジェクトの全セッションを時系列連結。'
    ),
  cwd: z.string().optional().describe("プロジェクトディレクトリ検出の上書き。"),
})

const zFallbackAdvisorOutput = z.object({
  advice: z.string(),
  requestedModel: z.string(),
  respondedModel: z.string().nullable(),
  fallbackOccurred: z.boolean(),
  fallbackFrom: z.string().optional(),
  fallbackTo: z.string().optional(),
  refusalCategory: z.string().optional(),
  scope: z.string(),
  sessionCount: z.number(),
  messageCount: z.number(),
  transcriptChars: z.number(),
  costUsd: z.number().optional(),
  numTurns: z.number().optional(),
  note: z.string().optional(),
  // isError は本ツールの堅牢性の中心。拒否・エラー・タイムアウト時も呼び出し元を
  // 中断させず、失敗を構造化して透過的に報告するために出力へ含める。
  isError: z.boolean(),
})

export type FallbackAdvisorInput = z.infer<typeof zFallbackAdvisorInput>
export type FallbackAdvisorOutput = z.infer<typeof zFallbackAdvisorOutput>

// ---------------------------------------------------------------------------
// Transcript serialization helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…[+${s.length - max} chars]`
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === "string") return b
        const block = b as { type?: string; text?: string } | null
        if (block && block.type === "text" && typeof block.text === "string") {
          return block.text
        }
        try {
          return JSON.stringify(b)
        } catch {
          return String(b)
        }
      })
      .join("\n")
  }
  try {
    return JSON.stringify(content ?? "")
  } catch {
    return String(content)
  }
}

function serializeBlock(block: unknown): string {
  const b = block as {
    type?: string
    text?: string
    thinking?: string
    name?: string
    input?: unknown
    content?: unknown
  } | null
  const t = b?.type
  if (t === "text") return typeof b?.text === "string" ? b.text : ""
  if (t === "thinking") {
    // signature は捨てる。
    return `[thinking] ${typeof b?.thinking === "string" ? b.thinking : ""}`
  }
  if (t === "tool_use") {
    const name = typeof b?.name === "string" ? b.name : "unknown"
    let inp: string
    try {
      inp = JSON.stringify(b?.input ?? {})
    } catch {
      inp = String(b?.input)
    }
    return `[tool_use name=${name}] ${truncate(inp, BLOCK_TRUNCATE_CHARS)}`
  }
  if (t === "tool_result") {
    return `[tool_result] ${truncate(
      stringifyToolResultContent(b?.content),
      BLOCK_TRUNCATE_CHARS
    )}`
  }
  return `[${t ?? "unknown"} omitted]`
}

/**
 * user / assistant メッセージ 1 件を見出し付き文字列へ整形する。
 * それ以外(type==='system' 等)は null を返し、呼び出し側でスキップする。
 */
function serializeMessage(msg: {
  type: string
  message: unknown
}): string | null {
  if (msg.type !== "user" && msg.type !== "assistant") return null
  const heading = msg.type === "user" ? "## User" : "## Assistant"
  const raw = msg.message as { content?: unknown } | null
  const content = raw?.content
  let body: string
  if (typeof content === "string") {
    body = content
  } else if (Array.isArray(content)) {
    body = content
      .map(serializeBlock)
      .filter((s) => s.length > 0)
      .join("\n")
  } else {
    body = ""
  }
  return `${heading}\n${body}`
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n)
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function runFallbackAdvisor(
  input: FallbackAdvisorInput
): Promise<FallbackAdvisorOutput> {
  const scope: "session" | "project" = input.scope ?? "session"
  const requestedModel =
    input.model ?? process.env.FALLBACK_ADVISOR_MODEL ?? DEFAULT_MODEL
  const dir = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

  const maxChars = envNumber(
    "FALLBACK_ADVISOR_MAX_CHARS",
    DEFAULT_MAX_TRANSCRIPT_CHARS
  )
  const timeoutMs = envNumber("FALLBACK_ADVISOR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)

  const notes: string[] = []

  const baseError = (advice: string): FallbackAdvisorOutput => ({
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

  // 1-2. セッション一覧を取得
  const sessions = await listSessions({
    dir,
    includeWorktrees: false,
    includeProgrammatic: false,
  })
  if (sessions.length === 0) {
    return baseError(
      `no sessions found for dir=${dir} (MCP サーバの cwd が対象プロジェクトと異なる場合は input.cwd か環境変数 CLAUDE_PROJECT_DIR を指定してください)`
    )
  }

  // 3. 対象セッションを決定
  const byLastModifiedDesc = [...sessions].sort(
    (a, b) => b.lastModified - a.lastModified
  )
  let targetSessions: typeof sessions
  if (scope === "session") {
    const latest = byLastModifiedDesc[0]
    if (!latest)
      return baseError(
        `no sessions found for dir=${dir} (MCP サーバの cwd が対象プロジェクトと異なる場合は input.cwd か環境変数 CLAUDE_PROJECT_DIR を指定してください)`
      )
    targetSessions = [latest]
  } else {
    // project: 古い → 新しい
    targetSessions = [...sessions].sort(
      (a, b) => a.lastModified - b.lastModified
    )
  }

  // 4-5. 各セッションのメッセージを取得しシリアライズ
  const parts: string[] = []
  let messageCount = 0
  let sessionCount = 0
  for (const session of targetSessions) {
    let messages: Awaited<ReturnType<typeof getSessionMessages>>
    try {
      messages = await getSessionMessages(session.sessionId, { dir })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      notes.push(`session ${session.sessionId} をスキップ: ${reason}`)
      continue
    }
    sessionCount += 1
    for (const msg of messages) {
      const serialized = serializeMessage(msg)
      if (serialized === null) continue
      parts.push(serialized)
      messageCount += 1
    }
  }

  if (messageCount === 0) {
    return baseError(
      `対象セッションから user/assistant メッセージを取得できませんでした (dir=${dir}, scope=${scope})`
    )
  }

  // 6. 総文字数上限(末尾=最新側を優先して先頭を切る)
  let transcript = parts.join("\n\n")
  const rawLen = transcript.length
  if (rawLen > maxChars) {
    // マーカー分を差し引いて、最終長が maxChars を超えないようにする。
    const sliceStart = Math.max(0, rawLen - maxChars + OMIT_MARKER.length)
    transcript = OMIT_MARKER + transcript.slice(sliceStart)
    notes.push(
      `トランスクリプトが上限(${maxChars}字)を超えたため古い履歴を省略しました(元${rawLen}字)`
    )
  }
  const transcriptChars = transcript.length

  // 8. プロンプト組み立て
  const context = input.context?.trim()
  let prompt = `以下はエージェントの会話トランスクリプトです。\n\n${transcript}`
  if (context) {
    prompt += `\n\n---\n【相談者からの追加指示】\n${context}`
  }
  prompt += "\n\n上記を踏まえ、レビュアーとして助言してください。"

  // 9. タイムアウト付き AbortController
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), timeoutMs)

  const stderrChunks: string[] = []

  // 10. 収集用ステート
  const assistantTexts: string[] = []
  let lastAssistantModel: string | null = null
  let fallbackOccurred = false
  let fallbackFrom: string | undefined
  let fallbackTo: string | undefined
  let refusalCategory: string | undefined
  let noFallback = false
  let noFallbackCategory: string | undefined
  let noFallbackExplanation: string | undefined
  // biome-ignore lint/suspicious/noExplicitAny: SDK の結果メッセージは緩く扱う
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
    const response = query({
      prompt,
      options: {
        model: requestedModel,
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        // tools:[] のため権限プロンプトは発生しない。bypassPermissions 等は
        // 不要かつ read-only advisor には過剰な権限なので付与しない。
        abortController,
        env: { ...process.env },
        stderr: (d) => {
          stderrChunks.push(d)
        },
      },
    })

    for await (const message of response) {
      // biome-ignore lint/suspicious/noExplicitAny: SDKMessage は緩く扱う
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
        `レビュアーモデルの応答がタイムアウトしました (${timeoutMs}ms)。`,
        true,
        lastAssistantModel
      )
    }
    const reason = err instanceof Error ? err.message : String(err)
    return finalize(`推論中にエラーが発生しました: ${reason}`, true, null)
  } finally {
    clearTimeout(timer)
  }

  // 11. advice を決定
  // 拒否かつフォールバック無しは、success(空文字) より優先して明示的に surface する。
  if (noFallback) {
    refusalCategory = noFallbackCategory
    let advice = "モデルが拒否し、フォールバックもありませんでした。"
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
        : `推論がエラーで終了しました (subtype=${String(resultMsg.subtype)})`
    return finalize(advice, true, lastAssistantModel)
  }
  if (assistantTexts.length > 0) {
    const respondedModel =
      lastAssistantModel ??
      (fallbackOccurred ? (fallbackTo ?? null) : requestedModel)
    return finalize(assistantTexts.join("\n\n"), false, respondedModel)
  }
  return finalize("応答が得られませんでした。", true, lastAssistantModel)
}

// ---------------------------------------------------------------------------
// MCP server wiring (no side effects at import time except registration)
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "FallbackAdvisor",
  title: "FallbackAdvisor",
  description:
    "現在の会話(またはプロジェクト全体)のトランスクリプトを、より強力なレビュアーモデルに渡してセカンドオピニオンを得る MCP サーバー。",
  version: "0.0.0",
})

server.registerTool(
  "FallbackAdvisor",
  {
    title: "FallbackAdvisor",
    description:
      "Claude Agent SDK の通常推論でセカンドオピニオンを返す。モデルが拒否した場合、SDK 既定の refusal-fallback が発生すれば別モデルで完走し、応答モデル・フォールバックの有無を透過的に報告する。フォールバック無しの拒否・エラー・タイムアウトも握り潰さず構造化して返す。",
    inputSchema: zFallbackAdvisorInput,
    outputSchema: zFallbackAdvisorOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input: z.infer<typeof zFallbackAdvisorInput>) => {
    try {
      const output = await runFallbackAdvisor(input)
      return {
        content: [{ type: "text", text: output.advice }],
        structuredContent: output,
        isError: output.isError,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const advice = `FallbackAdvisor 実行中にエラーが発生しました: ${message}`
      const output: FallbackAdvisorOutput = {
        advice,
        requestedModel:
          input.model ?? process.env.FALLBACK_ADVISOR_MODEL ?? DEFAULT_MODEL,
        respondedModel: null,
        fallbackOccurred: false,
        scope: input.scope ?? "session",
        sessionCount: 0,
        messageCount: 0,
        transcriptChars: 0,
        isError: true,
      }
      return {
        content: [{ type: "text", text: advice }],
        structuredContent: output,
        isError: true,
      }
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (import.meta.main) {
  void main()
}
