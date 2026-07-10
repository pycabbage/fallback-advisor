---
status: accepted
date: 2026-07-11
addressed-by: "0002"
---

# 1. Advisor モデルに Fable 5 を指定すると Advisor tool が失敗する問題

## 背景 / Context

Claude Code の Advisor tool（サーバー側 `advisor_20260301` tool）は、会話履歴全体を上位のレビュアーモデルへ転送してセカンドオピニオンを得る機能である。

Advisor モデルとして **Fable 5** を指定している場合に限り、Advisor tool の実行が失敗するケースが観測されている。

- 表面上は **API 呼び出し失敗** として現れる。とりわけ問題なのは、graceful なフォールバックではなく **tool calling 自体がハードに失敗し、呼び出し元の実行（ターン）が中断される**ケースがあること。
- しかし、Opus 4.8 などを Advisor モデルに指定した場合と比較して失敗の頻度が明らかに多い。
- この頻度差から、失敗の主因は単なる一時的な API エラーではなく、**Fable 5 が備える「蒸留・リバースエンジニアリング対策（セーフガード）」の暴走**である可能性が高いと考えている。

> 注: セーフガード暴走という原因は現時点では**仮説**であり、断定ではない。表面上のエラーが API 呼び出し失敗である点、および Opus 4.8 との頻度差が根拠。

## 決定 / Decision

この問題が顕著であるため、**暫定対応として Advisor モデルには Opus 4.8 を指定**して運用する。

## 結果 / Consequences

- Advisor tool は安定して動作するようになる。
- 一方で、本来 Advisor モデルとして使いたい Fable 5 を利用できないという制約が残る。
- この制約への対応（拒否時も実行を中断させない自前 Advisor）は [ADR-0002](0002-self-hosted-fallback-advisor-mcp.md) で扱う。なお Opus 4.8 運用と自前 Advisor は併存し得る。
