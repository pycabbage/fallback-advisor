import { expect, test } from "bun:test"
import { BLOCK_TRUNCATE_CHARS, OMIT_MARKER } from "./config"
import {
  applyCharBudget,
  serializeBlock,
  serializeMessage,
  stringifyToolResultContent,
  tail,
  truncate,
} from "./transcript"

// ---------------------------------------------------------------------------
// serializeBlock
// ---------------------------------------------------------------------------

test("serializeBlock: text block returns its text", () => {
  expect(serializeBlock({ type: "text", text: "hello" })).toBe("hello")
})

test("serializeBlock: thinking block is prefixed and drops the signature", () => {
  const out = serializeBlock({
    type: "thinking",
    thinking: "deep thought",
    signature: "sig-should-be-dropped",
  })
  expect(out).toBe("[thinking] deep thought")
  expect(out).not.toContain("sig-should-be-dropped")
})

test("serializeBlock: tool_use includes name and JSON-encoded input", () => {
  expect(
    serializeBlock({ type: "tool_use", name: "Bash", input: { cmd: "ls" } })
  ).toBe('[tool_use name=Bash] {"cmd":"ls"}')
})

test("serializeBlock: tool_use truncates long input", () => {
  const longValue = "x".repeat(BLOCK_TRUNCATE_CHARS + 500)
  const out = serializeBlock({
    type: "tool_use",
    name: "Bash",
    input: { cmd: longValue },
  })
  expect(out.startsWith("[tool_use name=Bash] ")).toBe(true)
  expect(out).toContain("chars]")
  // The serialized input portion is truncated to the budget plus the marker.
  expect(out.length).toBeLessThan(longValue.length)
})

test("serializeBlock: tool_result with string content", () => {
  expect(serializeBlock({ type: "tool_result", content: "result text" })).toBe(
    "[tool_result] result text"
  )
})

test("serializeBlock: tool_result with array content joins text blocks", () => {
  expect(
    serializeBlock({
      type: "tool_result",
      content: [
        { type: "text", text: "line a" },
        { type: "text", text: "line b" },
      ],
    })
  ).toBe("[tool_result] line a\nline b")
})

test("serializeBlock: unknown type is marked omitted", () => {
  expect(serializeBlock({ type: "image" })).toBe("[image omitted]")
  expect(serializeBlock({})).toBe("[unknown omitted]")
})

// ---------------------------------------------------------------------------
// serializeMessage
// ---------------------------------------------------------------------------

test("serializeMessage: user with string content", () => {
  expect(serializeMessage({ type: "user", message: { content: "hi" } })).toBe(
    "## User\nhi"
  )
})

test("serializeMessage: assistant with array content", () => {
  expect(
    serializeMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "yo" }] },
    })
  ).toBe("## Assistant\nyo")
})

test("serializeMessage: system returns null", () => {
  expect(
    serializeMessage({ type: "system", message: { content: "boot" } })
  ).toBeNull()
})

// ---------------------------------------------------------------------------
// applyCharBudget
// ---------------------------------------------------------------------------

test("applyCharBudget: under the limit is returned unchanged", () => {
  const result = applyCharBudget("short", 1000)
  expect(result.transcript).toBe("short")
  expect(result.truncated).toBe(false)
  expect(result.originalLength).toBe(5)
})

test("applyCharBudget: over the limit keeps the newest side within maxChars", () => {
  const transcript = "A".repeat(1000) + "B".repeat(1000)
  const maxChars = 500
  const result = applyCharBudget(transcript, maxChars)

  expect(result.truncated).toBe(true)
  expect(result.originalLength).toBe(2000)
  // Marker included, the final length never exceeds maxChars.
  expect(result.transcript.length).toBeLessThanOrEqual(maxChars)
  // Leads with the omission marker.
  expect(result.transcript.startsWith(OMIT_MARKER)).toBe(true)
  // The newest (trailing) content is retained; the oldest is dropped.
  expect(result.transcript.endsWith("B")).toBe(true)
  expect(result.transcript).not.toContain("A")
})

test("applyCharBudget: maxChars below the marker length drops the marker", () => {
  const result = applyCharBudget(`${"X".repeat(100)}TAIL`, 4)

  expect(result.truncated).toBe(true)
  expect(result.originalLength).toBe(104)
  // No room for the marker: it is omitted and exactly maxChars newest chars kept.
  expect(result.transcript).toBe("TAIL")
  expect(result.transcript.length).toBe(4)
  expect(result.transcript.startsWith(OMIT_MARKER)).toBe(false)
})

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

test("truncate: under the limit returns the string unchanged", () => {
  expect(truncate("hello", 10)).toBe("hello")
  expect(truncate("hello", 5)).toBe("hello")
})

test("truncate: over the limit appends the remaining-count suffix", () => {
  expect(truncate("abcdefghij", 4)).toBe("abcd…[+6 chars]")
})

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

test("tail: longer than n returns exactly the last n characters", () => {
  expect(tail("abcdef", 2)).toBe("ef")
})

test("tail: shorter than or equal to n returns the string unchanged", () => {
  expect(tail("abc", 5)).toBe("abc")
  expect(tail("abc", 3)).toBe("abc")
})

// ---------------------------------------------------------------------------
// stringifyToolResultContent
// ---------------------------------------------------------------------------

test("stringifyToolResultContent: a string is passed through", () => {
  expect(stringifyToolResultContent("plain")).toBe("plain")
})

test("stringifyToolResultContent: an array of text blocks is joined by newline", () => {
  expect(
    stringifyToolResultContent([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ])
  ).toBe("one\ntwo")
})

test("stringifyToolResultContent: a non-text array element is JSON-encoded", () => {
  expect(stringifyToolResultContent([{ type: "image", data: "xyz" }])).toBe(
    '{"type":"image","data":"xyz"}'
  )
})

test("stringifyToolResultContent: a plain object falls back to JSON", () => {
  expect(stringifyToolResultContent({ a: 1 })).toBe('{"a":1}')
})
