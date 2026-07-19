import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileLogger } from "./logger"
import type { Scope } from "./schema"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `fallback-advisor-logger-test-${Date.now()}-${Math.random()}`
  )
  mkdirSync(tmpRoot, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
  delete process.env.FALLBACK_ADVISOR_LOG
  delete process.env.FALLBACK_ADVISOR_LOG_DIR
})

function baseStart(cwd: string) {
  return {
    callId: "call-1",
    scope: "session" as Scope,
    cwd,
    contextChars: 0,
    config: {
      model: "fable",
      timeoutMs: 300_000,
      maxChars: 200_000,
      maxTurns: 1,
      allowRead: false,
      allowWeb: true,
      mcpConfigPaths: [] as string[],
      allowToolPatterns: [] as string[],
      claudePath: "/fake/claude",
    },
  }
}

function baseEnd(cwd: string) {
  return {
    callId: "call-1",
    cwd,
    durationMs: 12.3,
    outcome: "success" as const,
    requestedModel: "fable",
    respondedModel: "fable",
    fallbackOccurred: false,
    sessionCount: 1,
    messageCount: 1,
    transcriptChars: 100,
    adviceChars: 50,
    isError: false,
    sawInit: true,
  }
}

/** Read every JSONL line under `root` (recursing one directory deep). */
function readAllRecords(root: string): unknown[] {
  if (!existsSync(root)) return []
  const records: unknown[] = []
  for (const projectDir of readdirSync(root)) {
    const projectPath = join(root, projectDir)
    for (const file of readdirSync(projectPath)) {
      const content = readFileSync(join(projectPath, file), "utf8")
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) continue
        records.push(JSON.parse(line))
      }
    }
  }
  return records
}

// ---------------------------------------------------------------------------
// enabled: writes start + end, correlated by callId
// ---------------------------------------------------------------------------

test("enabled: logStart + logEnd write exactly 2 JSONL lines correlated by callId", () => {
  process.env.FALLBACK_ADVISOR_LOG = "true"
  process.env.FALLBACK_ADVISOR_LOG_DIR = tmpRoot
  const cwd = "/home/ubuntu/fallback-advisor"

  const logger = createFileLogger()
  logger.logStart(baseStart(cwd))
  logger.logEnd(baseEnd(cwd))

  const records = readAllRecords(tmpRoot) as Array<Record<string, unknown>>
  expect(records.length).toBe(2)
  const start = records.find((r) => r.phase === "start")
  const end = records.find((r) => r.phase === "end")
  expect(start).toBeDefined()
  expect(end).toBeDefined()
  expect(start?.callId).toBe("call-1")
  expect(end?.callId).toBe("call-1")
  expect(start?.schemaVersion).toBe(1)
  expect(end?.schemaVersion).toBe(1)
})

// ---------------------------------------------------------------------------
// projectSlug: directory layout
// ---------------------------------------------------------------------------

test("projectSlug: cwd's '/' are replaced with '-' to form the project directory name", () => {
  process.env.FALLBACK_ADVISOR_LOG = "true"
  process.env.FALLBACK_ADVISOR_LOG_DIR = tmpRoot
  const cwd = "/home/ubuntu/fallback-advisor"

  const logger = createFileLogger()
  logger.logStart(baseStart(cwd))

  const expectedDir = join(tmpRoot, "-home-ubuntu-fallback-advisor")
  expect(existsSync(expectedDir)).toBe(true)
  const files = readdirSync(expectedDir)
  expect(files.length).toBe(1)
  expect(files[0]).toMatch(/^\d+-\d+-[0-9a-f]+\.jsonl$/)
})

// ---------------------------------------------------------------------------
// disabled: no file is created at all
// ---------------------------------------------------------------------------

test("FALLBACK_ADVISOR_LOG=false: no directory or file is created", () => {
  process.env.FALLBACK_ADVISOR_LOG = "false"
  process.env.FALLBACK_ADVISOR_LOG_DIR = tmpRoot
  const cwd = "/some/project"

  const logger = createFileLogger()
  logger.logStart(baseStart(cwd))
  logger.logEnd(baseEnd(cwd))

  // The root itself was created by the test fixture (beforeEach), but nothing
  // inside it (no project subdirectory) should have been added.
  expect(readdirSync(tmpRoot).length).toBe(0)
})

// ---------------------------------------------------------------------------
// env read at write time, not construction time
// ---------------------------------------------------------------------------

test("env is read lazily at write time: changing FALLBACK_ADVISOR_LOG/_LOG_DIR after construction still takes effect", () => {
  // Deliberately leave env unset (or disabled) at construction time.
  delete process.env.FALLBACK_ADVISOR_LOG
  delete process.env.FALLBACK_ADVISOR_LOG_DIR
  process.env.FALLBACK_ADVISOR_LOG = "false"

  const logger = createFileLogger()
  const cwd = "/lazy/env/project"

  // First write while disabled: must be a true no-op.
  logger.logStart(baseStart(cwd))
  expect(existsSync(tmpRoot)).toBe(true)
  expect(readdirSync(tmpRoot).length).toBe(0)

  // Now flip env AFTER the logger was already constructed, and point it at
  // the tmp root for this test.
  process.env.FALLBACK_ADVISOR_LOG = "true"
  process.env.FALLBACK_ADVISOR_LOG_DIR = tmpRoot

  logger.logEnd(baseEnd(cwd))

  const records = readAllRecords(tmpRoot)
  expect(records.length).toBe(1)
  expect((records[0] as Record<string, unknown>).phase).toBe("end")
})

// ---------------------------------------------------------------------------
// multiple calls append to the same file
// ---------------------------------------------------------------------------

test("the same logger instance appends multiple calls to a single process-scoped file", () => {
  process.env.FALLBACK_ADVISOR_LOG = "true"
  process.env.FALLBACK_ADVISOR_LOG_DIR = tmpRoot
  const cwd = "/multi/call/project"

  const logger = createFileLogger()
  logger.logStart({ ...baseStart(cwd), callId: "call-a" })
  logger.logEnd({ ...baseEnd(cwd), callId: "call-a" })
  logger.logStart({ ...baseStart(cwd), callId: "call-b" })
  logger.logEnd({ ...baseEnd(cwd), callId: "call-b" })

  const projectDir = join(tmpRoot, "-multi-call-project")
  const files = readdirSync(projectDir)
  // A single process => a single file, even across multiple calls.
  expect(files.length).toBe(1)

  const records = readAllRecords(tmpRoot) as Array<Record<string, unknown>>
  expect(records.length).toBe(4)
  const callIds = records.map((r) => r.callId).sort()
  expect(callIds).toEqual(["call-a", "call-a", "call-b", "call-b"])
})

// ---------------------------------------------------------------------------
// write failure never throws
// ---------------------------------------------------------------------------

test("a write failure (unwritable log dir) is swallowed, not thrown", () => {
  process.env.FALLBACK_ADVISOR_LOG = "true"
  // Point the log dir at a path whose parent is actually a file, so mkdir
  // fails (ENOTDIR) on every write attempt.
  const blockerFile = join(tmpRoot, "blocker")
  mkdirSync(tmpRoot, { recursive: true })
  writeFileSync(blockerFile, "not a directory", "utf8")
  process.env.FALLBACK_ADVISOR_LOG_DIR = join(blockerFile, "nested", "logs")

  const logger = createFileLogger()
  expect(() => logger.logStart(baseStart("/whatever"))).not.toThrow()
  expect(() => logger.logEnd(baseEnd("/whatever"))).not.toThrow()
})

// ---------------------------------------------------------------------------
// cwd/root re-resolved per write (regression test for the memoization bug:
// a single `filePath` memoized outside of any per-directory key would pin
// every subsequent call in this process to the FIRST resolved directory,
// silently misfiling a later call's records under the wrong project or root).
// ---------------------------------------------------------------------------

test("a cwd change on the same logger instance writes to two separate per-project files, not one shared file", () => {
  process.env.FALLBACK_ADVISOR_LOG = "true"
  process.env.FALLBACK_ADVISOR_LOG_DIR = tmpRoot
  const cwdA = "/project/A"
  const cwdB = "/project/B"

  const logger = createFileLogger()
  logger.logStart({ ...baseStart(cwdA), callId: "call-a" })
  logger.logEnd({ ...baseEnd(cwdA), callId: "call-a" })
  logger.logStart({ ...baseStart(cwdB), callId: "call-b" })
  logger.logEnd({ ...baseEnd(cwdB), callId: "call-b" })

  const dirA = join(tmpRoot, "-project-A")
  const dirB = join(tmpRoot, "-project-B")
  expect(existsSync(dirA)).toBe(true)
  expect(existsSync(dirB)).toBe(true)
  // Each project directory gets its own process-scoped file...
  expect(readdirSync(dirA).length).toBe(1)
  expect(readdirSync(dirB).length).toBe(1)

  // ...and each file contains only records for its own cwd (call-a never
  // leaks into project B's file, and vice versa).
  const recordsA = readAllRecords(join(tmpRoot)).filter(
    (r) => (r as Record<string, unknown>).cwd === cwdA
  ) as Array<Record<string, unknown>>
  const recordsB = readAllRecords(join(tmpRoot)).filter(
    (r) => (r as Record<string, unknown>).cwd === cwdB
  ) as Array<Record<string, unknown>>
  expect(recordsA.length).toBe(2)
  expect(recordsB.length).toBe(2)
  expect(recordsA.every((r) => r.callId === "call-a")).toBe(true)
  expect(recordsB.every((r) => r.callId === "call-b")).toBe(true)

  const fileContentA = readFileSync(
    join(dirA, readdirSync(dirA)[0] as string),
    "utf8"
  )
  expect(fileContentA).not.toContain("call-b")
  const fileContentB = readFileSync(
    join(dirB, readdirSync(dirB)[0] as string),
    "utf8"
  )
  expect(fileContentB).not.toContain("call-a")
})

test("changing FALLBACK_ADVISOR_LOG_DIR after the first write sends subsequent writes to the new root", () => {
  const firstRoot = tmpRoot
  const secondRoot = join(
    tmpdir(),
    `fallback-advisor-logger-test-second-root-${Date.now()}-${Math.random()}`
  )
  mkdirSync(secondRoot, { recursive: true })

  try {
    process.env.FALLBACK_ADVISOR_LOG = "true"
    process.env.FALLBACK_ADVISOR_LOG_DIR = firstRoot
    const cwd = "/same/project"

    const logger = createFileLogger()
    logger.logStart({ ...baseStart(cwd), callId: "call-first-root" })
    expect(readAllRecords(firstRoot).length).toBe(1)

    // Flip the root AFTER a successful write, on the SAME logger instance.
    process.env.FALLBACK_ADVISOR_LOG_DIR = secondRoot
    logger.logEnd({ ...baseEnd(cwd), callId: "call-second-root" })

    // The first root must not have gained the second record...
    expect(readAllRecords(firstRoot).length).toBe(1)
    // ...it must have gone to the new root instead.
    const secondRecords = readAllRecords(secondRoot) as Array<
      Record<string, unknown>
    >
    expect(secondRecords.length).toBe(1)
    expect(secondRecords[0]?.callId).toBe("call-second-root")
  } finally {
    rmSync(secondRoot, { recursive: true, force: true })
  }
})
