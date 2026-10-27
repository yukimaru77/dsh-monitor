# dsh-monitor

[pi-event-monitor](https://github.com/Helmi/pi-event-monitor)（のバッチ通知版）を
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) に移植したプラグインです。
バックグラウンドのシェルコマンドやファイルを見張り、開始したセッションに通知して作業を再開させます。

## 動作

### コマンドの監視（`monitor_start`）
- 指定したシェルコマンドをバックグラウンドで動かし、その出力を開始したセッションに知らせます。
- 出力が出たらすぐに届けます。0.2秒以内に続けて出た行は1回の通知にまとめます（先頭3行と末尾20行、1行256バイトまで）。改行で終わっていない行は、続きが来るか終了するまで待ちます。
- **注意**: 起こされるたびに通知が会話に積まれます。出力し続けるコマンドを見張ると、AI がずっと起こされ続けてコンテキストが汚れます。`grep --line-buffered` などで必要な行だけに絞るか、`interval_minutes` で定期まとめにし、不要になったら `monitor_stop` で止めます。
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

このプラグインは、上の動作（bash は10秒で job に移る、30分ごとの報告と完了通知が届くので待ち続けない、monitor_start は出力し続けるコマンドに使わない）を AI へのコンテキスト（`shell-commands`）でも伝えます。DSH 標準の `bash` の説明文は書き換えられないためです。

通知はDSHのagent inboxで届きます。待機中のセッションは新しいターンで起こし、作業中のセッションには次のステップへ差し込みます。

### goal の待機（`GOAL_WAIT`）
pi-goal-x の `GOAL_WAIT` と同じ動きです。
- goal が active のときに、ターンの最後の返答に `GOAL_WAIT` が含まれていて、このセッションの monitor か動いている bash job があっても、1回目はすぐには待ちません。次のラウンドで「待っているものとは独立に進められる作業・深掘り・調査は本当にないか。なければもう一度 `GOAL_WAIT` を」と確認します。
- その次のターンの最後にも `GOAL_WAIT` があれば、goal の自動ラウンドを止めます。goal 自体は active のままです（DSH の `disarm`）。判定はターンの最後の返答だけなので、確認のターンでファイルなどを見てから `GOAL_WAIT` を出しても続けて出したことになります。`GOAL_WAIT` で終わらないターンやユーザーの入力を挟むと、確認はやり直しです。
- ユーザーのメッセージや monitor・job の通知で次のターンが始まると、自動ラウンドを戻します（`resume`）。そのターンが goal の続きになり、必要ならまた `GOAL_WAIT` で待てます。
- 待っている間に goal が pause・blocked・完了・削除されたときは、そのままにします。
- monitor も動いている bash job もないときは待機せず、次のターンで AI に「GOAL_WAIT は通らなかった」と伝えます。
- goal が active の間は、いつ `GOAL_WAIT` を使うかを AI へのコンテキスト（`goal-wait`）で伝えます。
- 待機は DSH の再起動をまたぎません（DSH は再起動時に goal の自動ラウンドを止めるため、`/goal resume` で再開します）。

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
