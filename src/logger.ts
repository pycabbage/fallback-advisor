import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { version } from "../package.json"
import { loggingEnabled, resolveLogDir } from "./config"
import type { Scope } from "./schema"

// ---------------------------------------------------------------------------
// Per-call JSONL logging: one line per start/end event, correlated by callId,
// so a later incident can be diagnosed offline (e.g. with DuckDB) without
// relying on anything still resident in memory. See
// docs/adr/0006-per-call-jsonl-diagnostic-log.md.
//
// Design constraints (see docs/adr/0006-per-call-jsonl-diagnostic-log.md for the "why"):
// - JSONL, not a columnar format: each record is fsync-adjacent-durable via
//   appendFileSync, so a killed process still leaves prior records intact.
// - One directory per project (slug of the server process's cwd), one file
//   per process (a fresh epochMs-pid-rand name is chosen on first write and
//   reused for every subsequent write in that process's lifetime).
// - Metadata only: transcript/advice bodies are never written, only their
//   lengths.
// ---------------------------------------------------------------------------

export type AdvisorOutcome =
  | "success"
  | "success_fallback"
  | "success_partial"
  | "timeout"
  | "exception"
  | "refusal_no_fallback"
  | "result_error"
  | "empty"
  | "no_sessions"
  | "no_messages"
  | "mcp_config_error"
  | "claude_path_missing"

export type LogStartInput = {
  callId: string
  scope: Scope
  cwd: string
  contextChars: number
  config: {
    model: string
    timeoutMs: number
    maxChars: number
    maxTurns: number
    allowRead: boolean
    allowWeb: boolean
    mcpConfigPaths: string[]
    allowToolPatterns: string[]
    claudePath: string
  }
}

export type LogEndInput = {
  callId: string
  cwd: string
  durationMs: number
  outcome: AdvisorOutcome
  requestedModel: string
  respondedModel: string | null
  fallbackOccurred: boolean
  fallbackFrom?: string
  fallbackTo?: string
  refusalCategory?: string
  sessionCount: number
  messageCount: number
  transcriptChars: number
  costUsd?: number
  numTurns?: number
  adviceChars: number
  isError: boolean
  note?: string
  sawInit: boolean
  timeToFirstSdkMessageMs?: number
  stderrTail?: string
  errorMessage?: string
}

type LogStartRecord = LogStartInput & {
  schemaVersion: 1
  phase: "start"
  ts: string
  pid: number
  serverVersion: string
  env: {
    useBedrock: boolean
    useVertex: boolean
    useFoundry: boolean
    hasDefaultOpusModel: boolean
    hasDefaultSonnetModel: boolean
    hasDefaultHaikuModel: boolean
    hasDefaultFableModel: boolean
  }
  execPath: string
}

type LogEndRecord = LogEndInput & {
  schemaVersion: 1
  phase: "end"
  ts: string
}

export type AdvisorLogger = {
  logStart(rec: LogStartInput): void
  logEnd(rec: LogEndInput): void
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Replace every '/' with '-' so a cwd like /home/ubuntu/fallback-advisor
 * becomes a single path segment: -home-ubuntu-fallback-advisor.
 */
function projectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-")
}

/** Presence-only check (never records the value itself). */
function hasEnv(name: string): boolean {
  const raw = process.env[name]
  return raw !== undefined && raw !== ""
}

function buildStartRecord(input: LogStartInput): LogStartRecord {
  return {
    ...input,
    schemaVersion: 1,
    phase: "start",
    ts: new Date().toISOString(),
    pid: process.pid,
    serverVersion: version,
    env: {
      useBedrock: hasEnv("CLAUDE_CODE_USE_BEDROCK"),
      useVertex: hasEnv("CLAUDE_CODE_USE_VERTEX"),
      useFoundry: hasEnv("CLAUDE_CODE_USE_FOUNDRY"),
      hasDefaultOpusModel: hasEnv("ANTHROPIC_DEFAULT_OPUS_MODEL"),
      hasDefaultSonnetModel: hasEnv("ANTHROPIC_DEFAULT_SONNET_MODEL"),
      hasDefaultHaikuModel: hasEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
      hasDefaultFableModel: hasEnv("ANTHROPIC_DEFAULT_FABLE_MODEL"),
    },
    execPath: process.execPath,
  }
}

function buildEndRecord(input: LogEndInput): LogEndRecord {
  return {
    ...input,
    schemaVersion: 1,
    phase: "end",
    ts: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// createFileLogger: no arguments, reads no env at construction time, holds
// no state until the first write. The file path is memoized per resolved
// directory (not globally), keyed by `${root}/${projectSlug}` computed fresh
// on every write from FALLBACK_ADVISOR_LOG_DIR (at write time) and the call's
// cwd. This keeps "one file per process" for a given (root, cwd) pair while
// still honoring a `cwd` that changes across calls (e.g. `input.cwd`, a
// documented per-call override) and a FALLBACK_ADVISOR_LOG_DIR changed after
// the first write: each distinct directory gets its own process-scoped file,
// so a call for project B is never silently appended to project A's file.
// ---------------------------------------------------------------------------

export function createFileLogger(): AdvisorLogger {
  const filePathByDir = new Map<string, string>()

  const write = (cwd: string, record: unknown): void => {
    // Read FALLBACK_ADVISOR_LOG at write time (not at construction time) so
    // that a CLI flag applied after DEFAULT_DEPS is constructed still takes
    // effect, and so disabling logging is a true no-op (no directory/file
    // is ever created).
    if (!loggingEnabled()) return
    try {
      // Read FALLBACK_ADVISOR_LOG_DIR and re-derive the project directory at
      // write time (not memoized outside this function) for the same
      // reason: both the log root and the call's cwd can legitimately differ
      // between calls on a single long-lived logger instance.
      const dir = join(resolveLogDir(), projectSlug(cwd))
      let filePath = filePathByDir.get(dir)
      if (filePath === undefined) {
        mkdirSync(dir, { recursive: true })
        const rand = randomUUID().slice(0, 8)
        filePath = join(dir, `${Date.now()}-${process.pid}-${rand}.jsonl`)
        filePathByDir.set(dir, filePath)
      }
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
    } catch {
      // A logging failure must never break the advisor itself. If mkdir or
      // appendFileSync failed, `dir` simply has no entry in filePathByDir
      // yet, so the next write() call for that directory retries path
      // resolution from scratch.
    }
  }

  return {
    logStart(rec) {
      write(rec.cwd, buildStartRecord(rec))
    },
    logEnd(rec) {
      write(rec.cwd, buildEndRecord(rec))
    },
  }
}
