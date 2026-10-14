# ローカルPi ChatGPTログインによるLunaスモークテスト

対象: #91（親 #38）。所有者の実行許可は
[LOCAL_LUNA_ACCEPTANCE_AUTHORIZATION.md](LOCAL_LUNA_ACCEPTANCE_AUTHORIZATION.md) に記録済み。
このスクリプトはユーザー自身が同じ手順で実行し、結果JSONだけを共有できるようにするものです。

## 検証範囲

Piの公開 `ModelRuntime` / Durable SDKで、既存のOpenAI OAuthログインを使い、
`openai/gpt-6-luna` が型付き確認ツールを一度実行して正常終了することを確認します。
保存された入力結果が完了していること、SQLiteを閉じて再読込してもモデル要求と
ツール応答が再実行されないことまで検証します。

`low` が通常の指定です。明示的に `--effort max` とした場合だけMaxで実行します。
Maxの成功は高い推論設定での疎通試験であり、独立QCループの完了を意味しません。
実PI WEBのブラウザ、並列エージェント、公開PR、再起動時の外部状態照合は #92 に残ります。
このスクリプトはGitHubへpushせず、PRを作らず、既存daemonを操作しません。

## 準備

Linux、Node 22または24、対象リポジトリのクリーンなレビュー済みチェックアウトを使います。
PiでChatGPTにログインしているのと同じOSユーザーで実行してください。
実行前に `git status --short` と `git rev-parse HEAD` を確認します。
未保存の変更を消すためのresetや、認証ファイルのコピーは不要です。

```sh
npm ci --no-audit --no-fund
npm run test:e2e:local-luna -- --mode faux
```

fauxは認証情報を読みません。実SDKと模擬モデルで監督プロセス・保存・再読込を確認します。
結果には必ず `authentication: "not-verified"` と記録されます。

## Luna Lowを一度実行する

レビューしたコミットのSHAを明示し、既存アカウントの利用と通常のOAuth更新を承認します。
アカウント利用枠を消費する可能性があります。秘密値をコマンドやチャットへ貼らないでください。

```sh
SHA=$(git rev-parse HEAD)
RECEIPTS=$(mktemp -d /tmp/mm-luna-result-XXXXXX)
npm run test:e2e:local-luna -- \
  --mode oauth --effort low \
  --expected-sha "$SHA" --approve-account-use \
  --receipt "$RECEIPTS/luna-low.json"
RESULT=$?
printf 'exitCode=%s\n' "$RESULT"
cat "$RECEIPTS/luna-low.json"
```

`npm run` の見出しを省き、JSONだけの標準出力が必要なら、同じ引数で
`node scripts/local-pi-oauth-smoke.mjs` を直接実行できます。
このコマンドはその実装の正規のCLIであり、認証・隔離・権限検証の回避経路ではありません。

認証ファイルは既定で `~/.pi/agent/auth.json` です。別のPiプロファイルを所有者が
選択している場合のみ、`--pi-auth-file /絶対パス/auth.json` で明示してください。
`PI_CODING_AGENT_DIR`、APIキー、models.json、プロキシ設定などの暗黙の代替は使いません。
認証ファイルが存在しない、OAuthでない、シンボリックリンク、共有読取可能等の場合は拒否します。
スクリプトはそのファイルの権限変更・コピー・手動トークン書換えをしません。
Piの標準ストアが必要な通常のOAuth更新を担当します。

## Luna Maxの確認（必要なときだけ）

Lowの結果を確認した後、Maxの疎通も確認する場合は、上記の `--effort low` を
`--effort max` に、結果ファイルを新しい `luna-max.json` に変更して実行します。
既存の結果ファイルは上書きしません。自動的な再試行やMaxへの切替はありません。

## 上限と状態の扱い

| 設定 | Low | Max |
| --- | --- | --- |
| モデル | openai/gpt-6-luna | 同左 |
| SDK要求受付数 | 最大4回 | 最大4回 |
| 1要求の最大出力トークン指定 | 1024 | 4096 |
| SDK全体の制限時間 | 60秒 | 120秒 |

SDK側の再試行を無効にし、上限の外側では監督プロセスが停止を要求します。
終了しなければ、今回開始した子プロセスだけを強制停止します。
モデルには確認ツールしか与えず、シェル・ファイル・Git・任意拡張は提供しません。
これはSDK接続試験であって、モデルプロバイダーのネットワーク処理全体のOS隔離試験ではありません。

一時SQLiteは新規のprivateディレクトリに作成し、SDK終了と子プロセス終了の確認後だけ削除します。
終了を確認できない場合は成功にせず、一時状態を保持します。
既存セッションや本番データを復元・削除しません。
出力トークンやSDK要求数は厳密な金額保証ではありません。

## 共有するもの・しないもの

共有するのは**最後の結果JSONとexitCode**です。
そのJSONにはコミット、依存関係のバージョン、lockfileのハッシュ、要求数、各検証の成否が含まれます。
トークン、アカウントID、認証ファイル、SQLite、モデル本文、SDKの生のエラーログは共有しないでください。
親プロセスはSDK子プロセスの標準出力・標準エラーを転送しません。

| exitCode / status | 意味 |
| --- | --- |
| 0 / passed | 今回の型付き応答・完了保存・再読込の条件を満たした |
| 1 / failed | 実行または証拠の保存が失敗。成功として扱わない |
| 2 / blocked | 承認・ソース・認証ファイル等の事前条件を満たさず、実行しなかった |

`approval-required` は承認不足、`sha-mismatch` は指定SHAと不一致、
`dirty-checkout` は作業ツリーの変更、`credential-required` は認証ファイル等の不適合です。
`model-unavailable` は固定モデル/推論設定を確認できなかったこと、
`input-not-completed` / `runtime-failed` は正常完了を証明できなかったことを示します。
`timed-out` / `shutdown-unproved` の場合も無制限に再試行しないでください。
結果が不明な場合はJSONを共有し、その原因を先に確認します。

## 前回の拒否との関係

前回のツール拒否と未実施項目は [過去の状態記録](LOCAL_LUNA_ACCEPTANCE_STATUS.md) に残します。
今回の所有者の再試験/手動実行依頼を受け、同じDesktop Commanderのファイル作成ツールが
この制限付きスクリプトを受け入れました。ツール設定やセキュリティ設定は変更していません。
もし実行が拒否された場合はその結果を明記し、別の実行経路から自動再試行しません。
スクリプトの回帰テスト成功だけで #91/#92 を完了とはしません。
