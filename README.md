# fallback-advisor

Claude Code の Advisor 相当のセカンドオピニオンを、サーバー側 advisor tool を介さず Claude Agent SDK の通常推論で提供し、モデルが拒否した場合も実行を中断させない MCP ツールです。

## セットアップ

```sh
# TODO: セットアップ手順は後で記述する
```

<details>
<summary>解決する課題: Fable 5 を Advisor モデルにすると Advisor tool がハード失敗する</summary>

### 現在の Claude Code の問題

Claude Code の Advisor tool（サーバー側 `advisor_20260301`）は、会話履歴全体を上位のレビュアーモデルへ渡してセカンドオピニオンを得る機能です。しかし **Advisor モデルに Fable 5 を指定すると、tool calling 自体がハードに失敗**します（`The advisor tool is unavailable.`）。graceful なフォールバックが無く、呼び出し元の実行（ターン）がそのまま中断されてしまいます。Opus 4.8 では発生しないため、やむを得ず Opus 4.8 を Advisor モデルに指定して回避していました。

### このプロジェクトの解決策

同等のセカンドオピニオンを、`advisor_20260301` を介さず **Claude Agent SDK の通常推論**として実装します。

- `~/.claude/projects/` から対象プロジェクトの会話履歴を読み込み、レビュアー用のプロンプトで単発推論します。
- モデルが拒否しても、SDK 純正の refusal-fallback により別モデルへ自動フォールバックし、**実行を完走**させます。どのモデルが応答したか・フォールバックの有無は透過的に返します。
- セーフガードは尊重し、回避を目的とはしません（拒否は拒否として扱います）。
- Claude Agent SDK は内部で Claude Code を動かすため、Claude サブスクリプションの利用枠で動作します。

設計判断の詳細は [`docs/adr/`](docs/adr/README.md) を参照してください。

</details>
