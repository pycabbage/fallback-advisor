---
status: accepted
date: 2026-07-11
supersedes: "0001"
depends-on: "0003"
---

# 2. Advisor 相当機能を自前の MCP Tool（Fallback Advisor）として実装する

## 背景 / Context

[ADR-0001](0001-fable5-advisor-safeguard-issue.md) のとおり、サーバー側 `advisor_20260301` tool を Fable 5 で使うと、セーフガードの暴走とみられる失敗が頻発する。

重要な観察として、**Advisor tool 経由の推論と通常の推論とでは、セーフガードの発動閾値が異なることが実証済み**である。すなわち、同じ Fable 5 でも「`advisor_20260301` tool を介さない通常推論」であれば、暴走を回避できる可能性が高い。

## 決定 / Decision

Advisor tool と同等の処理を行う **自前の MCP Tool**（本プロジェクト `fallback-advisor` が公開する `FallbackAdvisor` tool）を実装する。処理の流れは以下のとおり:

1. `~/.claude/projects/` から、対象プロジェクトの会話履歴（JSONL）を**全て読み込む**。
2. 会話履歴と tool input を結合したメッセージを構築し、**Claude Agent SDK を用いて推論**する。
   - このとき **サーバー側 `advisor_20260301` tool は使用しない**。
   - Advisor 相当のプロンプト（レビュアーとしての役割・観点の指示）は**本ツール側で用意する**。
3. 推論結果を tool の返却値として返す。

### 最重要ポイント

**`advisor_20260301` tool を使用しないこと。** Advisor tool 使用時と通常推論とでセーフガードの発動閾値が異なることは実証済みであるため、「通常推論」として実行することでセーフガードの暴走を回避できる可能性が高い。これが本アプローチの核心である。

## 結果 / Consequences

- Fable 5 を含む任意のモデルを、セーフガード暴走のリスクを抑えつつ Advisor 用途で利用できるようになる見込み。
- Advisor 相当のプロンプト設計・会話履歴のシリアライズ・対象プロジェクトディレクトリの特定などを、自前で実装・保守する必要が生じる。
- 推論基盤（どの SDK で推論を実行するか）の選定は [ADR-0003](0003-claude-agent-sdk-as-inference-engine.md) で扱う。
