import type {
  getSessionMessages,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk"
import type { Scope } from "./schema"
import { serializeMessage } from "./transcript"

// ---------------------------------------------------------------------------
// Session selection and message retrieval (dependencies injectable)
// ---------------------------------------------------------------------------

export type HistoryDeps = {
  listSessions: typeof listSessions
  getSessionMessages: typeof getSessionMessages
}

export type LoadTranscriptResult = {
  /** Serialized user/assistant messages, oldest first. */
  parts: string[]
  /** Number of sessions whose messages were successfully read. */
  sessionCount: number
  /** Number of user/assistant messages collected. */
  messageCount: number
  /** Informational notes (e.g. skipped sessions). */
  notes: string[]
  /**
   * Number of sessions returned by `listSessions`. Distinguishes the
   * "no sessions" case (0) from the "sessions found but no messages" case.
   */
  sessionsFound: number
}

/**
 * Load and serialize the transcript for the requested scope.
 *
 * - "session": the single most recently modified session.
 * - "project": every session, concatenated from oldest to newest.
 */
export async function loadTranscript(
  deps: HistoryDeps,
  dir: string,
  scope: Scope
): Promise<LoadTranscriptResult> {
  const notes: string[] = []

  const sessions = await deps.listSessions({
    dir,
    includeWorktrees: false,
    includeProgrammatic: false,
  })
  if (sessions.length === 0) {
    return {
      parts: [],
      sessionCount: 0,
      messageCount: 0,
      notes,
      sessionsFound: 0,
    }
  }

  // Choose the target sessions.
  let targetSessions: typeof sessions
  if (scope === "session") {
    const byLastModifiedDesc = [...sessions].sort(
      (a, b) => b.lastModified - a.lastModified
    )
    const latest = byLastModifiedDesc[0]
    // `sessions` is non-empty here, so `latest` is defined; guard for the type.
    targetSessions = latest ? [latest] : []
  } else {
    // project: oldest -> newest
    targetSessions = [...sessions].sort(
      (a, b) => a.lastModified - b.lastModified
    )
  }

  const parts: string[] = []
  let messageCount = 0
  let sessionCount = 0
  for (const session of targetSessions) {
    let messages: Awaited<ReturnType<typeof getSessionMessages>>
    try {
      messages = await deps.getSessionMessages(session.sessionId, { dir })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      notes.push(`Skipped session ${session.sessionId}: ${reason}`)
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

  return {
    parts,
    sessionCount,
    messageCount,
    notes,
    sessionsFound: sessions.length,
  }
}
