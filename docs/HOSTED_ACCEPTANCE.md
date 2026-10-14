# 実PI WEB・ブラウザ・Workflowのローカル受け入れ試験

対象: #92、#2–#4。SDK単体の #91 とは別の検証です。
既存サービスは停止・変更せず、新しい一時領域と別プロセスだけを使います。
モデル利用と同一リポジトリの試験ブランチは
[所有者の許可](LOCAL_LUNA_ACCEPTANCE_AUTHORIZATION.md)に従います。

## 準備

Linux、Node 22/24、動作するBubblewrapと通常のGitが必要です。
レビュー済みのクリーンな開発用チェックアウトで実行します。

```sh
npm ci --no-audit --no-fund
npm run build
npx playwright install chromium
```

不足するブラウザ共有ライブラリは、管理者が開発・CIホストの標準手順で用意します。
Chromeのサンドボックスを無効にして通す手順はありません。

## 資格情報なし: 実ホスト＋模擬モデル

```sh
npm run test:e2e:hosted -- --mode faux
```

これは実際のPI WEB、sessiond、Chromium、Micromanager、Durable、Git、
Bubblewrapを動かします。モデル応答だけを有限の合成応答に置き換えます。
本番用 `src/` の実行・承認処理は置換しません。試験専用の薄いプラグインラッパーが
公開WorkspacePanelContextを取得し、実ブラウザの公開peer通信を操作します。
非公開HTTPルート、偽のWorkflow状態、偽のQC結果・ツール終了値は使いません。

確認項目は、4並列の実Run、4枚の実カード表示、展開/折り畳み、画面からのSteer、
独立QC、2名の独立診断と統合、一度限りの人間による再開、daemon停止/再起動、
Abort後の再起動で重複実行しないこと、全試験プロセスの終了確認です。
このモードは実認証の成功を表さず、結果に `realModelAuthentication: not-verified` と記録します。

## 所有者による実Luna実行

次の操作は既存のPi ChatGPTアカウントの利用枠を消費します。
Luna Lowを実装/計画に、同じモデルのMaxをQC/調査に選びます。
APIキー・別モデル・別アカウント・既定設定へのフォールバックはありません。

```sh
SHA=$(git rev-parse HEAD)
RESULTS=$(mktemp -d /tmp/mm-hosted-result-XXXXXX)
npm run test:e2e:hosted -- \
  --mode oauth --expected-sha "$SHA" --approve-account-use \
  --receipt "$RESULTS/hosted-luna.json"
STATUS=$?
printf 'exitCode=%s\n' "$STATUS"
cat "$RESULTS/hosted-luna.json"
```

Piにログイン済みの同じOSユーザーで実行します。既定の `~/.pi/agent/auth.json`
以外を明示的に選ぶ場合だけ `--pi-auth-file /絶対パス/auth.json` を指定します。
資格情報はPiの公開SDKが管理し、コピーやコマンド引数へのトークン埋込みはしません。
試験用HOMEとPi状態は別領域です。モデルのファイル/シェルツールは既存の本番隔離を使い、
元のHOME・資格情報・Git管理領域・ネットワークをマウントしません。

最大同時Runは4、各Runは要求24回・ツール64回・5分以内、試行は2回です。
全体にも監督タイムアウトを設けます。SDK要求上限は金額・通信試行数の厳密な保証ではありません。
失敗時に自動で高いモデルや追加試行へ切り替えません。

## 同一リポジトリで実際の公開・復旧も確認する

**明示的な追加オプションでのみ**GitHubを書き換えます。対象は固定された
`zkamiyama/pi-micromanager` の新規 `e2e/local-luna-*` 試験用base/sourceブランチだけです。
`main`・release・既存ユーザーブランチは公開先になりません。
既存の通常のGitHub CLIログインを使用し、その資格情報はモデルツールに渡しません。
GitHubのブランチ保護やCIを無効にしません。

```sh
SHA=$(git rev-parse HEAD)
RESULTS=$(mktemp -d /tmp/mm-publication-result-XXXXXX)
npm run test:e2e:hosted -- \
  --mode faux --expected-sha "$SHA" --approve-test-publication \
  --receipt "$RESULTS/hosted-publication.json"
STATUS=$?
printf 'exitCode=%s\n' "$STATUS"
cat "$RESULTS/hosted-publication.json"
```

faux＋公開は、モデルだけ模擬で、実際のMicromanagerのQC・人間承認・Git push・
Draft PR・CI・exact-SHA merge・復旧を実行します。実モデルも合わせる場合は、
`--mode oauth --approve-account-use` とします。

公開の準備は新しい試験用基準ブランチに小さな合成テストを配置するだけです。
本体の試験では製品の公開経路がpush/PR/mergeを実行します。承認前に試験対象の
repository/base/source、QCのSHA、変更ファイルが `acceptance.txt` だけであることを検査します。
実GitHubマージの成功応答を一度だけ意図的に失わせ、試験用daemonを再起動します。
製品がGitHubの実状態から完了を照合し、同じmerge要求を再発行しないことを確認します。
二度目の外部mergeを試験監督側も拒否します。強制pushや曖昧な操作の無条件再実行はしません。

成功後も試験用リモート参照は証拠として残し、PR URLと各SHAを結果に記録します。
失敗/中断時は外部状態が不確実な可能性があるため一時状態も保持します。
`retainedFixture` は `/tmp/` 内の試験領域名です。状況を確認せず削除・再実行しないでください。

## 結果の解釈

共有するのは最終JSONと終了コードだけです。モデル本文、認証ファイル、SQLite、
生のserver/SDKログは共有しないでください。試験プロセスの標準出力/エラーは公開しません。

`status: passed` は実際に通した選択モードと検査の範囲だけの成功です。
模擬モデルの成功、既存アカウントの利用、同一リポジトリ内のブランチ分離は、
独立テナントの認証・隔離、TLS/外部公開、ホスト全体のハードクォータの証明ではありません。
本番サービスの起動・停止・デプロイはこのスクリプトの対象外です。
資格情報を使わないCIはこの試験をfauxのみで動かし、公開オプションを渡しません。
