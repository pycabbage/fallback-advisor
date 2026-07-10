# Architecture Decision Records (ADR)

このディレクトリは、`fallback-advisor` プロジェクトにおける重要な設計判断を **ADR (Architecture Decision Record)** として記録する。

- 1 ファイル = 1 決定。ファイル名は `NNNN-kebab-case-title.md`（連番）。
- 各 ADR は「ステータス / 背景 / 決定 / 結果」を記載する。
- 決定が置き換えられた場合は、旧 ADR のステータスを `Superseded by ADR-XXXX` とし、新 ADR から旧 ADR へリンクを張る。

## 一覧 / Index

| #    | タイトル                                                                                       | ステータス                                   |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0001 | [Advisor モデルに Fable 5 を指定すると Advisor tool が失敗する問題](0001-fable5-advisor-safeguard-issue.md) | Superseded by [ADR-0002](0002-self-hosted-fallback-advisor-mcp.md) |
| 0002 | [Advisor 相当機能を自前の MCP Tool（Fallback Advisor）として実装する](0002-self-hosted-fallback-advisor-mcp.md)   | Accepted                                     |
| 0003 | [Fallback Advisor の推論基盤として Claude Agent SDK を採用する](0003-claude-agent-sdk-as-inference-engine.md)     | Accepted                                     |

## 決定の流れ / Narrative

1. **ADR-0001**: サーバー側 `advisor_20260301` tool を Fable 5 で使うと、セーフガード暴走とみられる失敗が頻発する。暫定対応として Advisor モデルに Opus 4.8 を指定していた。
2. **ADR-0002**: Advisor tool を介さない「通常推論」ではセーフガード閾値が異なる（実証済み）ことを利用し、Advisor 相当機能を自前 MCP Tool として実装して暴走を回避する。
3. **ADR-0003**: その推論基盤として、Claude サブスクリプション枠を使える唯一の TS SDK である Claude Agent SDK を採用する。
