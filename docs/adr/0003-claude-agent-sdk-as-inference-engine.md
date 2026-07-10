---
status: accepted
date: 2026-07-11
required-by: "0002"
---

# 3. Fallback Advisor の推論基盤として Claude Agent SDK を採用する

## 背景 / Context

[ADR-0002](0002-self-hosted-fallback-advisor-mcp.md) の自前 MCP Tool では、会話履歴を入力として LLM 推論を実行する必要がある。TypeScript から LLM エージェント／推論を実行する手段は複数あるが、課金（利用枠）の観点で重要な差がある。

- **Claude Agent SDK は内部で Claude Code を動作させている。**
- **2026/06/15 に予定されていた課金体制の変更が見送りとなった**ことにより、Claude Agent SDK は「TypeScript から LLM エージェントを実行できる SDK でありながら、**Claude サブスクリプションの利用枠を利用できる唯一の SDK**」となっている。

## 決定 / Decision

Fallback Advisor の推論基盤として **Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）** を採用する。

## 結果 / Consequences

- 追加の API 従量課金を発生させることなく、既存の Claude サブスクリプション枠で Advisor 推論を実行できる。
- 一方で、Claude Code / Claude Agent SDK のバージョンや、Anthropic 側の課金体制の将来的な変更に依存する。前提（特に課金体制）が変われば本決定の再検討が必要になる。
