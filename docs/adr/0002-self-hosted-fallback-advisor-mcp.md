---
status: accepted
date: 2026-07-11
addresses: "0001"
depends-on: "0003"
---

# 2. Advisor 相当機能を自前の MCP Tool（Fallback Advisor）として実装する

## 背景 / Context

[ADR-0001](0001-fable5-advisor-safeguard-issue.md) のとおり、サーバー側 `advisor_20260301` tool を Fable 5 で使うと失敗が起きる。実運用上の本質的な困りごとは「**フォールバックが起きること**」ではなく、**tool calling 自体がハードに失敗し、呼び出し元の実行（ターン）が中断されること**である。

## スパイクによる検証 / Findings（2026-07-11）

実装前に、Claude Agent SDK の通常推論（自前の systemPrompt + `tools:[]`、`advisor_20260301` 不使用）を Fable 5 指定で実測した:

- セーフガードを刺激する内容では、**Fable 5 は通常推論でも拒否**した。当初仮説「通常推論なら閾値が異なり Fable 5 でも通る」は、この種の内容については**否定**された。
- ただし SDK 純正の **`model_refusal_fallback`** が自動発火し、別モデル（実測では Opus 4.8）へフォールバックして **success として結果を返した**（＝実行は完走）。認証・課金はサブスク経由で成功。

→ 本ツールの価値は「セーフガードの回避」ではなく、**拒否時も SDK 純正フォールバックで実行を完走させ、呼び出し元を中断させないこと**にある。セーフガードは確率的であり、**拒否は拒否として尊重する**（Fable 5 が拒否した出力を無理に引き出す設計にはしない）。

## 決定 / Decision

Advisor 相当の自前 MCP Tool（`FallbackAdvisor`）を実装する。処理の流れ:

1. Claude Agent SDK の `listSessions` / `getSessionMessages` で、対象プロジェクトの会話履歴を取得する（自前 JSONL パースではなく安定 API を使用）。
2. トランスクリプトと tool input を結合し、**自前の「レビュアー」systemPrompt** で通常推論する。
   - `advisor_20260301` tool は使わない。理由は、**安全機構を無効化・迂回するためではなく**、自前で制御可能な単発推論として実装し、tool-call のハード失敗による中断を避けるため。
   - systemPrompt には安全機構を回避・抑制する類の指示は一切含めない。
3. 拒否／フォールバックが発生した場合も、**実際に応答したモデル**とフォールバックの有無を**透過的に返す**。拒否かつフォールバックも無い場合は、握り潰さず明示的なエラー／メッセージとして返す。

## 結果 / Consequences

- 呼び出し元のワークフローが tool-call のハード失敗で中断しなくなる（＝主目的の達成）。
- Fable 5 が拒否する内容については、フォールバック先モデルの見解が返る。これは現行の Opus 運用（[ADR-0001](0001-fable5-advisor-safeguard-issue.md)）と同等であり、劣化ではなく安全側の挙動。
- 履歴取得・シリアライズ・拒否／フォールバックの透過報告を自前で保守する必要がある。
- 推論基盤は [ADR-0003](0003-claude-agent-sdk-as-inference-engine.md)。
