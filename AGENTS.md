# AGENTS

fallback-advisor: Claude Code の Advisor tool（`advisor_20260301`）が失敗したときのフォールバックとして、Claude Agent SDK 経由の通常推論でセカンドオピニオンを返す stdio MCP サーバー。

`CLAUDE.md` はこのファイルへのシンボリックリンク。

## Bun

Node.js ではなく Bun を使う。

- `bun install` / `bun test` / `bunx <pkg>`
- テストランナーは `bun test`（vitest/jest は使わない）
- `.env` は Bun が自動読込するので dotenv は不要

## Commands

- Install: `bun install`
- Test: `bun test`（単一ファイル: `bun test src/advisor.test.ts` / 名前指定: `bun test -t "<pattern>"`）
- Lint: `bun lint`（= `biome check`。自動修正: `biome check --write .`）
- Dev（MCP Inspector 経由起動）: `bun run dev`
- 直接起動: `bun run src/index.ts`
- Markdown ファイル（`*.md`）を追加・編集したら必須: `bun markdownlint-cli2 "**/*.md"`（ルールは `.markdownlint-cli2.jsonc` 参照）

## Architecture

stdio MCP サーバー。起動順は `src/index.ts`（`import.meta.main` の場合のみ CLI 起動）→ `src/cli.ts`（commander、`FALLBACK_ADVISOR_*` env とフラグをマッピング）→ `src/server.ts`（`FallbackAdvisor` tool 登録）→ `src/advisor.ts`（履歴読込 → プロンプト構築 → Agent SDK `query()` 呼び出し → 拒否/フォールバック/エラーを `isError` 付きで構造化返却、が中核ロジック）。

- `src/history.ts` / `src/transcript.ts`: セッション取得と、トランスクリプトのシリアライズ・文字数バジェット。
- `src/config.ts` / `src/schema.ts`: env 既定値と zod 入出力スキーマ。
- テストは `AdvisorDeps` / `HistoryDeps` を注入してフェイクに差し替える方式（モジュールモックではない）。
- `bun build --compile` の単一バイナリ配布では Agent SDK 自身のネイティブ依存解決が壊れるため、`query()` に `pathToClaudeCodeExecutable` を明示している（`src/config.ts` の `resolveClaudeExecutablePath`）。既定は `~/.local/bin/claude`（Linux 標準インストール想定）。それ以外の環境では `FALLBACK_ADVISOR_CLAUDE_PATH` の設定が必要。

設計判断の背景は @docs/adr/README.md を参照。
