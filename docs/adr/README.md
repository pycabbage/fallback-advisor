# Architecture Decision Records (ADR)

このディレクトリは、`fallback-advisor` プロジェクトにおける重要な設計判断を **ADR (Architecture Decision Record)** として記録する。

- 1 ファイル = 1 決定。ファイル名は `NNNN-kebab-case-title.md`（連番）。
- 各 ADR は「ステータス / 背景 / 決定 / 結果」を記載する。
- 決定が置き換えられた場合は、旧 ADR のステータスを `Superseded by ADR-XXXX` とし、新 ADR から旧 ADR へリンクを張る。

## 一覧 / Index

| #    | タイトル                                                                                       | ステータス                                   |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0001 | [Advisor モデルに Fable 5 を指定すると Advisor tool が失敗する問題](0001-fable5-advisor-safeguard-issue.md) | Accepted（[ADR-0002](0002-self-hosted-fallback-advisor-mcp.md) で対応） |
| 0002 | [Advisor 相当機能を自前の MCP Tool（Fallback Advisor）として実装する](0002-self-hosted-fallback-advisor-mcp.md)   | Accepted                                     |
| 0003 | [Fallback Advisor の推論基盤として Claude Agent SDK を採用する](0003-claude-agent-sdk-as-inference-engine.md)     | Accepted                                     |
| 0004 | [レビュアーに Read / Web ツールをオプトインで許可する](0004-optional-read-web-tools-for-reviewer.md)                 | Accepted                                     |
| 0005 | [レビュアーに MCP サーバーをオプトインで登録する](0005-optional-mcp-servers-for-reviewer.md)                         | Accepted                                     |

## 決定の流れ / Narrative

1. **ADR-0001**: サーバー側 `advisor_20260301` tool を Fable 5 で使うと失敗が頻発する。とりわけ tool-call がハードに失敗して実行が中断する。暫定対応として Advisor モデルに Opus 4.8 を指定していた。
2. **ADR-0002**: `advisor_20260301` を介さない自前 MCP Tool を実装し、拒否時も SDK 純正のフォールバックで**実行を完走**させ呼び出し元の中断を防ぐ。実装前スパイクで「通常推論なら Fable 5 でも通る」という当初仮説は否定されたが、フォールバックによる完走という価値は確認済み。セーフガードは尊重し、回避目的ではない。
3. **ADR-0003**: その推論基盤として、Claude サブスクリプション枠を使える唯一の TS SDK である Claude Agent SDK を採用する。
4. **ADR-0004**: `tools:[]`（ADR-0002）を 2 フラグ（`FALLBACK_ADVISOR_ALLOW_READ` はデフォルト off のオプトイン、`FALLBACK_ADVISOR_ALLOW_WEB` はデフォルト on）の後ろで条件付きに緩和する。確率的な `permissionMode:'auto'` は「外部世界への影響が絶対にない」保証にならないため却下し、代わりに決定論的な `canUseTool` コールバックで許可判定をハングなく即座に行う。`Read` は意図的にパス制限なし（`Read(*)` 相当）とし、README に安全上のトレードオフを明記する。ツール有効時（既定でも `WebSearch`/`WebFetch` が有効なので既定状態を含む）は `maxTurns` を 1 から引き上げる。
5. **ADR-0005**: `WebSearch`/`WebFetch` は Anthropic 直接 API 前提であり Bedrock/Vertex/サードパーティ推論プロバイダでは使えないため、`--mcp-config`（ファイルパスのみ）で任意の MCP サーバーをレビュアーに登録できるようにする。`--allow-tool`（`*` のみのグロブ、バックトラッキングなしの自前実装）で実行許可を別ゲートとして分離し、サーバーの登録自体は実行権限を与えない。
