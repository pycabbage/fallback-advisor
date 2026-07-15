---
status: accepted
date: 2026-07-15
relates-to: "0004"
---

# 5. レビュアーに MCP サーバーをオプトインで登録する

## 背景 / Context

[ADR-0004](0004-optional-read-web-tools-for-reviewer.md) はレビュアーの調査手段を `Read` / `WebSearch` / `WebFetch` の 2 フラグに限定した。しかし `WebSearch` / `WebFetch` は Anthropic 直接 API 前提の機能であり、Bedrock / Vertex AI / その他サードパーティ推論プロバイダ経由でホストされた Claude Code では利用できない。この場合、運用者は代替として Brave・Tavily・SearXNG など任意の検索 MCP サーバーを自分の Claude Code に導入していることが多いが、これらをレビュアーのサブプロセスへ引き渡す手段が今までなかった。

汎用の検索 MCP サーバーは無数に存在し（Brave、Tavily、SearXNG、Kagi、Exa、Serper…）、特定のサーバー名をこのツールにハードコードするのは筋が悪い。`FALLBACK_ADVISOR_ALLOW_READ` / `FALLBACK_ADVISOR_ALLOW_WEB` と同じ「運用者が明示的に opt-in する」パターンを一般化し、任意の MCP サーバーをレビュアーに渡せるようにする。

## 決定 / Decision

1. **`--mcp-config <files...>` / `FALLBACK_ADVISOR_MCP_CONFIG`** で、`{"mcpServers": {...}}` 形式の JSON ファイル（`.mcp.json` / `.claude.mcp.json` と同じ構造）を 1 つ以上受け取り、そのまま Agent SDK の `mcpServers` オプションへ渡す。Claude Code 本家の `--mcp-config` と同じファイル形式に合わせるが、**ファイルパスのみ**を受け付け、インライン JSON 文字列は受け付けない。理由: この MCP サーバーは起動時に一度だけ CLI フラグを読み、`FALLBACK_ADVISOR_MCP_CONFIG` という単一の環境変数文字列に変換して保持し、ツール呼び出しごとにその文字列を再パースする（既存の `FALLBACK_ADVISOR_ALLOW_READ` 等と同じ設計）。複数値はスペース区切りで 1 文字列に join されるため、空白を含み得るインライン JSON をここに混ぜると join/split の往復で内容が壊れる。ファイルパスに限定すればこの往復は安全である。
2. **`--allow-tool <patterns...>` / `FALLBACK_ADVISOR_ALLOW_TOOL`** で、`*` のみをワイルドカードとして解釈する glob パターン（例: `mcp__brave__*` でサーバー丸ごと、`mcp__brave__brave_web_search` で個別ツール）を 1 つ以上受け取り、既存の `canUseTool` の許可判定に追加する。個別ツール名ベースの許可（`--allowedTools` 相当）だけでは、運用者がサーバー内部のツール名をすべて把握していない場面で使いにくいため、サーバー単位の一括許可も選べるようにした。
3. **「MCP サーバーの登録」と「実行時の許可」を意図的に分離する。** `--mcp-config` で `mcpServers` に登録しても、対応する `--allow-tool` パターンが無ければ `canUseTool` は全て deny する。これは ADR-0004 が確立した「決定論的な `canUseTool` が唯一の許可経路である」という方針をそのまま拡張したものであり、`mcpServers` オプション自体はツールをモデルに公開するだけで実行権限を与えない（Agent SDK の型定義・コメントで確認済み: 実行許可は `canUseTool` / `allowedTools` / `disallowedTools` のみが握る）。
4. **`allowToolPatterns` のグロブマッチングはバックトラッキング正規表現ではなく自前実装とする。** `pattern.replace("*", ".*")` を `^...$` としてコンパイルする素朴な変換は、ワイルドカードと繰り返しリテラルが交互に並ぶパターン（例: `*a*a*a*a*`）に対して壊滅的バックトラッキングを起こし得る。`toolName` は接続された MCP サーバーが宣言する値であり本プロセスの制御下にないため、悪意あるサーバーが `canUseTool` を無期限にハングさせる経路になり得る。`*` でパターンを分割し、`indexOf` によるセグメント単位の前方探索で判定する自前アルゴリズムはバックトラッキングを持たず、`toolName.length` に対して線形時間で完了する。
5. **`~/.claude.mcp.json` のような特定パスはデフォルト化しない。** どの MCP 設定ファイルを読むかは運用者が起動コマンド（`claude mcp add ... -- fallback-advisor --mcp-config <path> --allow-tool 'mcp__brave__*'` 等）で明示的に指定する。
6. **`hasTools`（`canUseTool` 設置・`maxTurns` 引き上げの判定）は `toolNames` / `allowToolPatterns` / `mcpConfigPaths` のいずれかが空でなければ真になる。** `--mcp-config` だけを指定して `--allow-tool` を指定しない構成（全 deny 目的）でも `canUseTool` を設置する必要があるため。

## 結果 / Consequences

- 既定構成（`--mcp-config` 未指定）では `mcpServers` オプション自体が `query()` に渡らず、既存の挙動と完全に同一である。
- `--mcp-config` を指定した MCP サーバーの定義（コマンド・引数・認証情報を含む env）は、そのままレビュアーのサブプロセスに引き渡される。対応する `--allow-tool` パターンを指定しない限り、登録されたツールは呼び出せない。
- `--allow-tool` でサーバー丸ごと（`mcp__foo__*`）を許可すると、そのサーバーが持つ全ツール（書き込み系ツールを含む可能性がある）が解放される。これは `Read` にパス制限をかけない ADR-0004 の判断と同種のトレードオフであり、運用者の明示的な選択に委ねる。
- グロブマッチングの自前実装・ReDoS 耐性は `matchesToolPattern`（`src/config.ts`）のユニットテストで固定する。
