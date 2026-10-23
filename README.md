# dsh-monitor

[pi-event-monitor](https://github.com/Helmi/pi-event-monitor)（のバッチ通知版）を
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に移植したプラグインです。
バックグラウンドのシェルコマンドやファイルを見張り、開始したセッションに通知して作業を再開させます。

## 動作

### コマンドの監視（`monitor_start`）
- 指定したシェルコマンドをバックグラウンドで動かし、その出力を開始したセッションに知らせます。
- 出力が出たらすぐに届けます。0.2秒以内に続けて出た行は1回の通知にまとめます（先頭3行と末尾20行、1行256バイトまで）。改行で終わっていない行は、続きが来るか終了するまで待ちます。
- 必要な行だけで起こしたいときは、`grep --line-buffered` などでコマンド側を絞ります。
- `interval_minutes` を指定すると、すぐには知らせず、その間隔ごとのまとめに切り替わります（小数可。例: `30` で30分ごと）。新しい出力がない区間は知らせません。
- コマンドが終わったとき、または停止したときは、残りの出力と終了ステータスを1回で届けます。
- 既定ではタイムアウトしません（`timeoutMs` または `persistent: false` で時間制限）。stderr は一時ファイルにも保存します（1MBまで）。
- ファイルやフォルダの変化は、`fswatch -r src` のようなコマンドで見張ります。
- 監視は開始したセッションのものです。他のセッションからは一覧・停止できず、セッション終了時に通知なしで停止します。

### 長く動く bash（job）の報告
- `bash` は普通に実行すると10秒（`bash-sandbox` の `timeoutMs: 10000`、このプラグインのパッチで設定）まで待ち、終われば結果をそのまま返します。
- 10秒を過ぎたコマンドは止めずにDSHのjobへ移り、その時点の出力とjob IDが返ります（DSH標準の動作）。
- 動いている bash job は30分ごとに、エージェントがまだ読んでいない出力（先頭3行と末尾20行）をjob ID付きでセッションに知らせます。この読み取りは `job_output` の既読位置を進めます。新しい出力がない区間は知らせません。
- 終了は、DSH標準の `dsh-tool-jobs` が「finished [status, exit code]」として知らせます。

通知はDSHのagent inboxで届きます。待機中のセッションは新しいターンで起こし、作業中のセッションには次のステップへ差し込みます。

## ツール

| ツール | 内容 |
| --- | --- |
| `monitor_start` | コマンドをバックグラウンドで動かし、出力が出たらすぐ知らせる（`interval_minutes`、`timeoutMs`、`instruction` など） |
| `monitor_list` | このセッションの監視一覧 |
| `monitor_stop` | 監視を停止（`id` または `all`） |

## コマンド

```text
/monitor <説明> :: <コマンド>
/monitors
/monitor-stop <id|all>
```

例:

```text
/monitor app errors :: tail -f app.log | grep --line-buffered -E "ERROR|FATAL"
/monitor src changes :: fswatch -r src
```

## 導入

```sh
dsh plugin --profile web add "file:$PWD"
```

全presetのセッションで使えます。


## テスト

```sh
node scripts/link-dsh.mjs   # インストール済みDSHのパッケージをnode_modulesへリンク
npm test
```

## ライセンス

MIT。元のpi-event-monitor（Copyright (c) 2026 Helmi）のライセンスを [LICENSE](LICENSE) に含めています。
