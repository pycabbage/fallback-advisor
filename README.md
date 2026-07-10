# fallback-advisor

An MCP tool that provides a Claude Code Advisor-style second opinion via Claude Agent SDK normal inference — without going through the server-side advisor tool — and that does not interrupt the caller even when the model refuses.

## Setup

```sh
# TODO: write setup instructions later
```

<details>
<summary>The problem it solves: the Advisor tool hard-fails when Fable 5 is the Advisor model</summary>

### The current Claude Code problem

Claude Code's Advisor tool (the server-side `advisor_20260301`) forwards the whole conversation history to a stronger reviewer model to obtain a second opinion. However, **when Fable 5 is set as the Advisor model, the tool call itself hard-fails** (`The advisor tool is unavailable.`). There is no graceful fallback, so the caller's turn is simply interrupted. Because this does not happen with Opus 4.8, Opus 4.8 had to be used as the Advisor model as a workaround.

### How this project solves it

It implements the same second opinion as **Claude Agent SDK normal inference**, without going through `advisor_20260301`.

- It reads the target project's conversation history from `~/.claude/projects/` and runs a single-turn inference with a reviewer prompt.
- If the model refuses, the SDK's built-in refusal-fallback switches to another model so the run still **completes**. Which model actually responded, and whether a fallback occurred, are reported transparently.
- Safeguards are respected, not evaded (a refusal is treated as a refusal).
- Because the Claude Agent SDK runs Claude Code internally, it works within the Claude subscription quota.

> Operational note: a slow inference can still be cut off by the caller's own MCP tool-call timeout, which would re-introduce a hard failure. Configure a generous MCP tool timeout; the tool's internal timeout defaults to 300s.

See [`docs/adr/`](docs/adr/README.md) for the design decisions (in Japanese).

</details>
