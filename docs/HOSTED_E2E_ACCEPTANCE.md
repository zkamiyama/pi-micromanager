# 実PI WEB・並列Run・QC・公開復旧の受け入れ試験

対象は #92（親 #38）。#91 の所有者実行によるLuna Low SDKスモーク成功は
受け入れ済みであり、同じ試験をやり直す手順ではありません。
本書のランナーは実PI WEBに登録したMicromanager、実ブラウザの公開peer、
実Durable、隔離ツール、QC、公開承認・応答喪失後の照合を一つのシナリオにします。

**実装や模擬予行の成功は、実認証・実GitHub受け入れの成功ではありません。**
`--mode live` の実測JSONが確認できるまで #92 / #38 は未完了です。
既存サービス、main/releaseブランチ、本番状態は試験対象にしません。

## 3つのモード

| モード | 実際に動くもの | 意図的に動かさないもの |
| --- | --- | --- |
| `ui` | 独立PI WEB、サンドボックス有効Chromium、ローカルBasic認証入口、Workflow保存・daemon再起動後の読込 | モデル、GitHub |
| `rehearsal` | 上記＋実製品の並列Run・隔離ツール・QC・公開許可と再起動処理、実ローカルGit | モデルはfaux、GitHub通信はローカルbare Gitと明示的な応答模擬 |
| `live` | 上記の製品経路＋既存Pi ChatGPT OAuth / Luna Low、QCはMax、実GitHubの専用試験ブランチ | main/release公開、本番daemon、任意モデル、無制限再試行 |

UIのBasic認証はこの試験用のランダム値で、ブラウザ・HTTP/WebSocketを同じ
loopback入口に通します。未認証要求が401になることを確認します。
TLS、マルチテナント隔離、実デプロイ先の認証設定を証明するものではありません。
モデルやGitHubの資格情報をブラウザへ渡しません。

## 準備

Linux、Node 22/24、Bubblewrap/prlimit/flock/git、liveの場合はghと既存ログインが必要です。
PlaywrightはdevDependencyの固定バージョンを使い、Chromium sandboxを必ず有効にします。
必要なシステム依存関係は運用者が用意してください。名前空間が使えない場合に
`--no-sandbox`、権限昇格、OS保護解除で代用する手順はありません。

```sh
npm ci --no-audit --no-fund
npm run build
npx --no-install playwright install --only-shell chromium
npm run test:e2e:hosted -- --mode ui
npm run test:e2e:hosted -- --mode rehearsal
```

CIの `hosted-acceptance-rehearsal` は新しい使い捨てrunnerに依存関係を入れて
予行だけを実行します。秘密情報や書込みトークンを供給しません。
既存のNode 22/24および実隔離必須ジョブもそのまま維持します。

## 所有者が実認証・実公開を実行する

ユーザーが許可した `openai/gpt-6-luna` Low / QC Max、同一リポジトリの
新規 `e2e/local-luna-*` 作業・基準ブランチだけを使います。
ローカルのレビュー済みmainをクリーンにし、更新直後のコミットSHAを確認してください。
実行開始時にはGitHubのmainと指定SHAが一致することも検証します。

```sh
SHA=$(git rev-parse HEAD)
RESULTS=$(mktemp -d /tmp/mm-hosted-result-XXXXXX)
node scripts/local-hosted-e2e.mjs \
  --mode live --expected-sha "$SHA" \
  --approve-account-use --approve-test-publication \
  --receipt "$RESULTS/hosted.json"
RESULT=$?
printf 'exitCode=%s\n' "$RESULT"
cat "$RESULTS/hosted.json"
```

これはSDKスモークより多い呼出しを伴います。2つの独立した合成Task、独立QC、
最終統合と最終QC、停止確認用Taskを使います。1Runのモデル要求は最大12、
ツール50、180秒、同時Runは4、Workflowは最大2試行です。
全体にも有限の監督期限があります。これらは金額の厳密な上限ではありません。
QCの初回PASSを確認するシナリオで、意図的なQC失敗からのreworkは別の試験です。

モデル認証元は既定 `~/.pi/agent/auth.json`、GitHub設定は `~/.config/gh` です。
異なる承認済みプロファイルだけ `--pi-auth-file` / `--gh-config-dir` の絶対パスで
指定できます。資格情報はコピーせず、内容を表示せず、モデルのツールへマウントしません。
公開Pi SDKが通常のOAuth更新を扱います。APIキーや別providerへ暗黙に切り替えません。
既存ファイルの権限を自動で変更して通す機能はありません。

## 実際の試験順序

1. 新しいprivate HOME、agent/session/state、socket、loopback port、ブラウザを作成。
2. 実PI WEBの標準実行ファイルを起動。文書化されたplugin登録と公開Browser APIの
   `context.peer.request` を使います。非公開ホストルートは呼びません。
3. UIで合成Workflowを保存。試験daemonだけを終了・再起動し、同じWorkflowを取得。
4. 2つの異なるGit Worktreeで実装Runを観測し、公開peer経由でSteerを一度送信。
5. 実装・独立QC・最終統合・最終QCを製品に処理させる。モデル変更は生成された
   fixtureの `a.txt` / `b.txt` だけ。テストコードやCIの変更は公開前に拒否。
6. `ask` のまま作られた承認のTask、QC SHA、repository、base/sourceを確認して、
   この試験専用の対象だけ公開peer経由で承認。全体の権限をallowへ変更しません。
7. 製品の `Host.execFile` を包む試験専用アダプターが、成功したpushとmergeの
   応答だけを各一回失わせる。副作用実施前に成功を捏造するものではありません。
8. 試験daemonを再起動。製品が実remote状態を照合し、同じpush/mergeを再実行せず
   完了することを確認。曖昧な結果は再試行せず停止します。
9. 別の遅延TaskをAbortし、再起動後にRun・モデル要求が増えないことを確認。
10. 試験用ブラウザ・子孫プロセスの終了を確認。PID再利用やD-stateを終了と誤認しません。

非mainへの試験PRでも同じリポジトリのActionsは動きます。workflow定義や保護を
変更せず、製品側が実CIの結果を確認するまでmergeしません。試験refは削除せず
証拠として残します。失敗時に生成された一時状態も、未確定な結果を消すために
自動削除しません。JSONのtrial情報で専用refを特定できます。

## 製品の修正点と互換性

### 最終統合の許可済みSHA

従来は、最終統合がマージすべきQC済みSHAを `requiredAncestors` と混同しており、
最終Runには空の許可リストが渡っていました。隔離内にはGitメタデータがないため、
これは実統合を止める接続漏れです。新しい `allowedMergeShas` をimmutableな
launch記録に保存し、ホスト実行境界で現在のQCと再照合して、最終Runの固定Git brokerへ
渡します。依存Taskが起動前に含むべき祖先の条件とは分離します。

修正前コードで回帰テストが `undefined` と期待SHA配列の不一致により失敗し、
修正後に同じテストが成功しました。旧最終Runに新しい許可証拠がない場合は
安全側に拒否します。既存の不確実Runへ許可リストを後付けして自動再実行しません。

### 独立テストホストの認証元

`productionSecurity.modelAuthFile` はホスト設定限定の任意項目です。
省略時の既存動作は変えません。指定時はprivateな所有者ファイル・canonical pathを
検査し、プロジェクト・制御状態・実行パッケージ内の認証元を拒否します。
Workflowやモデル引数からこの値を変更できません。選択された認証元は
公開 `ModelRuntime` へ渡し、暗黙のcustom models.jsonは読みません。
readiness応答にパスや資格情報を追加しません。

## 結果の共有と残る保証範囲

共有するのは最後のJSONとexitCodeだけです。認証ファイル、SDK生ログ、SQLite、
モデル本文は送らないでください。`live`、`rehearsal`、`ui`を入れ替えて解釈しません。
`productionSafetyGuaranteed` は常にfalseです。プラットフォームのハードクォータ、
カーネル状態、独立セキュリティレビュー、運用GC等は別Issueの責務のままです。

## この変更の開発中に観測したローカル環境の障害

資格情報不要の実ホスト予行中、試験用Bubblewrapの子がLinuxのD-stateに残り、
`/proc/<test-pid>/wchan` は `exp_funnel_lock` を示しました。単独の `/bin/true`
子プロセスとWorkspace検査は完了しましたが、同じ実隔離呼出しは完了しませんでした。
根本的なカーネル原因は未確定です。OS保護解除や既存サービス再起動は行わず、
このタスクの試験を停止しました。途中のfull checkは完了・成功と数えません。

終了した親だけを見て子孫を終了済みとする問題を、ランナーのプロセス追跡で修正しました。
未終了の子孫、PID再利用、再親化は別に扱います。CIは新しい使い捨てホストで実隔離を
必須にした独立したコード検証であり、このローカルホストの修復や本番適格性の証明ではありません。
