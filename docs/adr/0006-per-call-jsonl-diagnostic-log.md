---
status: accepted
date: 2026-07-19
relates-to: "0003"
---

# 6. 呼び出しごとの診断ログを JSONL で記録する

## 背景 / Context

FallbackAdvisor が「タイムアウトした」と報告される間欠事象が起きた。再実行すると成功することが多く、調査の結果サーバー自体はハングしておらず（`isError: false` で完走している）、大きなトランスクリプトを送った際に推論が長時間かかり、**MCP クライアント側のツールタイムアウトが `FALLBACK_ADVISOR_TIMEOUT_MS` より先に発火した**可能性が濃厚だと分かった。

しかし発生当時のプロセスはすでに終了しており、何が起きたかを後から突き止める手段が何もなかった。次に同種のインシデントが起きたとき、以下の 3 パターンを区別できる記録が必要である。

- (a) start だけ記録され end が無い = 真のハング、あるいはプロセスが kill された
- (b) end が `outcome=success` かつ `durationMs` が大きい = クライアント側タイムアウトが疑われる（サーバー自身は完走している）
- (c) end が `outcome=timeout` / `outcome=exception` = サーバー内部のタイムアウト・例外

## 決定 / Decision

1. **形式は JSONL とし、parquet 等の列指向形式は採用しない。** 列指向形式は書き込みバッファがプロセス kill 時に失われ得る（(a) のケースをまさに記録できない）。JSONL は 1 行 = 1 レコードで `appendFileSync` により即ディスクへ書き込めるため、途中で kill されても直前までのレコードは残る。
2. **ディレクトリ構成はプロジェクト別 + プロセス別ファイル**とする: `<root>/<projectSlug>/<epochMs>-<pid>-<rand>.jsonl`。
   - `root` の既定値は `~/.fallback-advisor/logs`（`FALLBACK_ADVISOR_LOG_DIR` で上書き可能）。
   - `projectSlug` は呼び出し時の cwd の `/` を `-` に置換したもの（例: `/home/ubuntu/fallback-advisor` → `-home-ubuntu-fallback-advisor`）。プロジェクトごとに調査対象を絞れるようにするため。
   - ファイル名に ISO 8601 の `:` を使わず epoch ミリ秒を使う（ファイル名としての安全性のため）。同一プロジェクトで複数プロセスが並走してもファイル名が衝突しないよう `pid` と短い `rand`（`randomUUID` の先頭 8 文字）を足す。
   - 1 プロセスは生涯で 1 ファイルにのみ追記する（ファイルパスはロガーインスタンス内で初回書き込み時に解決し、以後メモ化する）。
3. **1 呼び出しにつき start / end の 2 レコードを、`callId`（`randomUUID`）で相関させる。** start のみで end が無いレコードが上記 (a) の直接的な証跡になる。
4. **メタデータのみを記録し、トランスクリプト本文・advice 本文は一切記録しない。** 記録するのは文字数（`contextChars` / `transcriptChars` / `adviceChars` 等）のみ。ログが機密情報の新たな保管場所になることを避ける。
5. **既定で有効。** `FALLBACK_ADVISOR_LOG`（既定 `true`）で無効化でき、無効時はディレクトリ・ファイルを一切作らない完全な no-op にする。`FALLBACK_ADVISOR_LOG_DIR` でルートディレクトリを上書きできる。CLI 側は既存の `--allow-web`/`--no-allow-web` と同じパターンで `--log`/`--no-log`/`--log-dir <dir>` を用意する。
6. **`createFileLogger()` は引数を取らず、生成時に環境変数を一切読まない。** `FALLBACK_ADVISOR_LOG` / `FALLBACK_ADVISOR_LOG_DIR` は `logStart`/`logEnd` の**書き込み時**に読む。理由: `DEFAULT_DEPS`（`src/advisor.ts`）はモジュール import 時に評価される一方、CLI（`src/cli.ts` の `applyServerOptions`）は `run()` 実行時に環境変数を設定する。生成時に env を読んでしまうと、`--no-log` / `--log-dir` を渡しても常に無視されてしまう。
7. **診断フィールドを、上記 3 パターンの切り分けに直接効くものに絞って厚くする。**
   - end: `sawInit`（system init メッセージを受信したか）、`timeToFirstSdkMessageMs`（`query()` 呼び出しから最初の SDK メッセージまでの `performance.now()` 経過）、`stderrTail`（失敗系のみ、SDK stderr 末尾 ~2KB、既存の `tail()` を再利用）、`errorMessage`（失敗系のみ、advice/例外メッセージの先頭 ~1KB）。
   - start: 推論ルーティングに影響する環境変数の**有無**（`useBedrock` / `useVertex` / `useFoundry` / `hasDefaultOpusModel` 等、値そのものは記録しない）、`execPath`。
   - `durationMs` は `performance.now()`（単調時計）ベース、壁時計 `ts` は別に ISO 文字列で持つ。
8. **`outcome` を列挙型として固定し、`advisor.ts` の全 return 経路に対応づける。** `success` / `success_fallback` / `success_partial` / `timeout` / `exception` / `refusal_no_fallback` / `result_error` / `empty` / `no_sessions` / `no_messages` / `mcp_config_error` / `claude_path_missing`。
9. **`logEnd` は `callId` ごとに厳密に 1 回だけ発行する。** `runFallbackAdvisor` 全体を `try/finally` で包み、`finally` で「まだ end を書いていなければ `outcome=exception` で必ず書く」安全網を置く。ロガー自身も `ended` フラグで冪等化し、2 回目以降の呼び出しは無視する。
10. **ログ書き込みの失敗は advisor 本体の失敗にしてはならない。** `mkdir`/`appendFileSync` を含む全処理を `try/catch` で握り潰す。ロギング機能自体が「タイムアウトしたと報告されたが実際は生きていた」という当初の問題を悪化させる（＝ロギングのせいで本来失敗しないはずの呼び出しが失敗する）ことは本末転倒である。

## 結果 / Consequences

- `AdvisorDeps`（`src/advisor.ts`）に `logger?: AdvisorLogger` を追加し、`DEFAULT_DEPS` にのみ `createFileLogger()` を実体として渡す。既存テストは `deps.logger` を渡していないため、`deps.logger?.` という参照はすべて自動的に no-op になり、無改変で通る。
- 既定構成のまま何もしなくても、`~/.fallback-advisor/logs/<projectSlug>/` 以下に呼び出しごとの記録が積み上がる。運用者は `FALLBACK_ADVISOR_LOG=false`（または `--no-log`）で即座に無効化できる。
- **分析上の読み方**: `<root>/<projectSlug>/*.jsonl` を DuckDB 等で `read_json` すれば、`callId` で self-join して start/end を対応づけられる。
  - end が存在しない `callId`（= (a)）は、そのプロセスがハングしたか kill されたことを示す。該当ファイルの mtime やプロセスの生存期間と合わせて調査する。
  - end が存在し `outcome IN ('success', 'success_fallback', 'success_partial')` かつ `durationMs` が大きい（= (b)）場合、サーバー自身は完走しているため、原因はクライアント側のツールタイムアウト設定にある可能性が高い。`timeToFirstSdkMessageMs` や `sawInit` を見て、SDK 側の起動遅延か推論そのものの長さかを切り分けられる。
  - end の `outcome IN ('timeout', 'exception', 'refusal_no_fallback', 'result_error', ...)`（= (c)）は、サーバー内部で完結した失敗であり、`errorMessage` / `stderrTail` で直接原因を追える。
- トランスクリプト・advice の本文は一切残らないため、ログ自体が新たな機密情報の露出経路にはならない（文字数のみが残る）。
- ログの保持期間・ローテーションは本 ADR の範囲外とし、必要になった時点で別途決定する。
