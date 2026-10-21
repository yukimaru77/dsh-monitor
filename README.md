# dsh-monitor

[pi-event-monitor](https://github.com/Helmi/pi-event-monitor)（のバッチ通知版）を
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に移植したプラグインです。
バックグラウンドのシェルコマンドやファイルを見張り、開始したセッションに通知して作業を再開させます。

## 動作

- シェル監視は既定で30分ごとに、前回の通知以降の出力の先頭3行と末尾20行をまとめて通知します（間の行数は省略数として示す）。
- 1行は256 UTF-8バイトまで。出力のない区間は通知しません。
- コマンドの終了・手動停止時は、残りの出力と終了コードを1回の通知で送ります。
- stderrは上限付きの一時ログにも保存します。
- 通知はDSHのagent inboxで届きます。待機中のセッションは新しいターンで起こし、作業中のセッションには次のステップへ差し込みます。
- 監視は開始したセッションのものです。他のセッションからは一覧・停止できず、セッション終了時に通知なしで停止します。
- 既定のタイムアウトや流量による停止はありません（`timeoutMs` / `maxLinesPerMinute` で指定可能）。パス監視は既定で毎分120イベントを超えると停止します。

## ツール

| ツール | 内容 |
| --- | --- |
| `monitor_start` | シェルコマンドを監視（`interval_minutes`、`timeoutMs`、`persistent`、`maxLinesPerMinute`、`instruction`） |
| `monitor_watch_path` | ファイル・ディレクトリの変更を監視（`recursive` など） |
| `monitor_list` | このセッションの監視一覧 |
| `monitor_stop` | 監視を停止（`id` または `all`） |

## コマンド

```text
/monitor <説明> :: <コマンド>
/monitor-watch <パス> [説明]
/monitors
/monitor-stop <id|all>
```

Pi版の詳細パネルはPi TUI専用のため、`/monitors` はテキストの一覧を返します。
Pi版のgoal連携（`GOAL_WAIT`）は移植していません。

## 導入

```sh
dsh plugin --profile web add "file:$PWD"
```

全presetのセッションで使えます。コマンドはDSHのworking directoryで、ユーザーのシェル（`$SHELL -lc`）により実行されます。
Pi版と同じくDSHのsandboxは通りません。

## テスト

```sh
node scripts/link-dsh.mjs   # インストール済みDSHのパッケージをnode_modulesへリンク
npm test
```

## ライセンス

MIT。元のpi-event-monitor（Copyright (c) 2026 Helmi）のライセンスを [LICENSE](LICENSE) に含めています。
