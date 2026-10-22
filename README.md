# dsh-monitor

[pi-event-monitor](https://github.com/Helmi/pi-event-monitor)（のバッチ通知版）を
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に移植したプラグインです。
バックグラウンドのシェルコマンドやファイルを見張り、開始したセッションに通知して作業を再開させます。

## 動作

### 長く動く bash（job）の報告
- `bash` は普通に実行すると10秒（`bash-sandbox` の `timeoutMs: 10000`、このプラグインのパッチで設定）まで待ち、終われば結果をそのまま返します。
- 10秒を過ぎたコマンドは止めずにDSHのjobへ移り、その時点の出力とjob IDが返ります（DSH標準の動作）。
- 動いている bash job は30分ごとに、エージェントがまだ読んでいない出力（先頭3行と末尾20行、1行256バイトまで）をjob ID付きでセッションに知らせます。この読み取りは `job_output` の既読位置を進めます。新しい出力がない区間は知らせません。
- 終了は、DSH標準の `dsh-tool-jobs` が「finished [status, exit code]」として知らせ、待機中のセッションを再開させます。残りの出力は `job_output` で読みます。

### ファイル・フォルダの監視
- `monitor_watch_path` で変更を見張り、変更があればすぐ（200ms単位でまとめて）知らせます。
- 監視は開始したセッションのものです。他のセッションからは一覧・停止できず、セッション終了時に通知なしで停止します。既定で毎分120イベントを超えると停止します。

通知はDSHのagent inboxで届きます。待機中のセッションは新しいターンで起こし、作業中のセッションには次のステップへ差し込みます。

## ツール

| ツール | 内容 |
| --- | --- |
| `monitor_watch_path` | ファイル・ディレクトリの変更を監視（`recursive` など） |
| `monitor_list` | このセッションの監視一覧 |
| `monitor_stop` | 監視を停止（`id` または `all`） |

## コマンド

```text
/monitor-watch <パス> [説明]
/monitors
/monitor-stop <id|all>
```

シェルコマンドの監視（Pi版の `monitor_start` / `/monitor`）は、上記の bash job の報告に置き換えたため持ちません。

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
