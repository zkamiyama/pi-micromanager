# ADR-0020: 単一所有者のWSL・Durable製品とローカル資源の扱い

- 日付: 2026-10-15
- 状態: **製品範囲として採択。下記の新機能は実装・検証完了の宣言ではない。**
- 決定者: リポジトリ所有者。会話中の「native同等化は不要」「Journalはローカル」「ADRはGitのdocs」「自分のWorktreeは回収」「Windows内WSLでYOLOを第一とする」という明示判断を記録する。
- 基準コード: `6dcb050aa3bdbb0e4fd28ed2173a8d64589596ec`。
- 関係: ADR-0018/0019のレイヤー分担を維持し、正式に対応する利用環境と必須機能を限定する。

## 1. 製品の正式対応範囲

**所有者一人がWindows内のWSL 2からlocalhostで使う、Pi Durableを用いたPI WEB開発ツール。** 公開GitHubリポジトリであることは、多人数向け公開Webサービスを運用するという意味ではない。

正式対応の自動実行経路はDurableのみ。native Piと同等にすること、nativeをDurable失敗時の退避先にすること、人間のnative Sessionを本製品で掃除することは要求しない。既存のnative互換コードや過去の状態を、文書の変更だけで黙って実行・移行・削除してはならない。

OS、所有者、Pi/PI WEB SDK、Git/gh、Bubblewrap、Windows/WSLカーネルは信頼基盤とする。悪意ある同一OSユーザー、管理者、カーネル侵害、tenant間隔離、公開SaaSの認証/TLS基盤を、このリリースの検証済み能力とは呼ばない。

## 2. YOLOと隔離を分離する

YOLOとは、所有者が先に指定したプロジェクト・モデル・リポジトリ・ベースブランチ・操作の範囲で、逐次承認なしに実行すること。対象の拡張、結果不明操作の再送、QCやGitHub checksの省略ではない。

従来の`productionSecurity.mode="production"`における外部変更の`ask`/`deny`条件は維持する。追加する`local-owner`は、所有者の明示設定と新規の専用状態領域を条件とし、旧production/native状態の暗黙の降格・移行を認めない。これは新しい設定契約であり、このADRの採択だけで利用可能になるわけではない。

両プロファイルで、Bubblewrap、制御データ/Workspace分離、固定Git broker、ホストallowlist、所有ロック、停止・終了確認、操作世代、有限予算、保存済み成否、exact-SHA merge、GitHub側の保護を必須とする。Workflowやモデルが隔離を自己申告することや、無効化して成功に見せることは認めない。

## 3. ローカルJournalとGitのADR

| データ | 正本 | Journalの役割 |
| --- | --- | --- |
| 短い実行経過・判断理由・テスト結果 | ローカル管理領域 | 派生ビューとして表示 |
| 画像 | ローカルの限定されたオブジェクト領域 | 必要時だけ読み込む |
| 採択したADR | 対象Gitリポジトリの`docs/adr/*.md` | 検証したファイルとコミットへリンク |
| 再実行防止・QC・外部操作の最小receipt | 制御プレーンの権威ある記録 | 成否と来歴を参照 |

Journal専用のクラウド公開・同期基盤、ADR専用のcommit/push/PRエンジン、ADR本文の二重管理は作らない。ADRの編集・レビュー・commitは通常のGit経路を使う。既存のレビュー用stageは残せるが、stageしたことを採択・公開完了とは呼ばない。

ADRリンクはproject/workspace・追跡された通常ファイル・対象コミットを検証する。可変ブランチの最新表示と、根拠になった固定コミットは区別する。短命なJournalを削除してもADRの決定・理由・代替案は本文だけで理解できるようにする。

画像はGitへの格納を既定条件にしない。ローカル取り込みにはRun/QC・ソースSHA・内容ハッシュ・生成元/選択元を記録する。操作者が選んだ画像は`operator-upload`であり、自動撮影やQC成功の証拠とは別である。画像を指すソースSHAがあっても、画像の中身がその実行の真実だと自動認定しない。既存のGit追跡済み画像の厳密な取り込みは別経路として維持できる。

ファイルへ直接アクセスできるOSユーザーも信頼境界内にいる。localhostであることを、任意の同一OSユーザーや悪意あるWebページに対する認証保証と取り違えない。ホストの既存認証・認可は維持し、外部公開は別プロファイルを要する。

## 4. 詳細ログを有限にする

完了Runの公開活動・短い判断理由はRun単位のJSONLをZstandardで圧縮する方針とし、まず総容量256 MiB・30日を既定値とする。圧縮形式/レベルはプロトコルではなく内部保存方式であり、読取時間と展開後サイズを制限する。

秘密値、隠れた思考過程、無制限の生トランスクリプト複製は対象外。画像/詳細ログは、完了・非pin・復旧不要の条件下で古いものから回収する。容量満杯なら処分可能な詳細を先に回収し、保護対象しか残っていなければ新しい詳細保存や新規実行を安全側に止める。

権威あるWorkflow、成功/失敗、Run/入力/操作ID、QC SHA、終了確認、外部照合、回収receiptは詳細ログとは別。ログを消した結果、古いRunを未実行扱いに戻してはならない。稼働中・不明状態のDurable SQLiteを、単なる圧縮ログとして動かさない。

## 5. 自分のWorktreeとDurableデータだけを回収する

Worktreeは一時的な作業用コピーであり、長期保存する根拠そのものではない。次を全て証明できる**Micromanagerが作ったWorktree**は自動回収してよい。

1. 元の作成receipt、Git登録、正規パス、project/workspace IDが一致する。
2. 関係するRunは終了・sealed済みで、未確定外部操作・人間待ち・未完了依存がない。
3. 必要な画像/詳細ログの回収と最小証拠の保存が済んでいる。
4. 必要コミットは保持するGit参照から到達できる。SHAを文字列で記録しただけでは保持証明にしない。
5. dirty、untracked、未確認のignoredファイル、submodule、別所有者のpathやleaseがない。
6. 非同期事前検査の後、実際の変更直前にも世代・権限・対象を再確認する。

削除はGitのWorktree管理操作で行い、`--force`や任意pathの再帰削除で検証を代用しない。Worktreeディレクトリ、Git branch/ref、ログ/画像の削除は別操作であり、作業コピーの回収と同時に成果の参照を消さない。

削除前に意図を永続化し、操作が不明なら自動再送しない。対象が無いだけで「自分の削除が成功した」と記録しない。失敗時のlease/tombstoneは照合のため保持する。

自分のDurable Run DBを回収する場合も、実runtimeの終了と保存済み成功、必要記録、同一Runの再作成を拒否するtombstoneが先行する。native Pi/PI WEB Sessionのファイル、JSONL、SQLite、ユーザーWorktreeは一切この回収権限に含めない。人間が作成したnative Sessionは人間とPI WEBが管理する。

## 6. WSLで確認する範囲

対象は一人のWindows/WSL環境であり、全WSL/Linux/SaaSの適格性認定は不要。localhostと既存認証、実際のworkerファイル/ネットワーク隔離、プロセス終了、入力/操作重複防止、容量/時間/要求上限、WSL再起動後の照合を実測する。

`.wslconfig`、Windows firewall、AppArmor、OS権限、本番daemonをテストが変更してはならない。WSL全体のメモリ/CPU設定は他の作業にも影響する運用設定であり、製品が自動で書き換えない。論理上限・容量スキャン・rlimitはハードaggregate quotaや正確な請求上限ではないことを表示する。

## 7. Issue・旧PRの明示的な処置

| 対象 | この判断による処置 |
| --- | --- |
| #2 | 既存の実測済みDurableアダプターで正式対応の受け入れ完了。native同等化は明示的非目標、実装済みとはしない |
| #5 | ローカル画像・有限な詳細ログ・Git ADRリンクに限定。UI接続/保存/回収/改変試験が完了するまでOpen |
| #89 | 自分のWorktree/Durable関連データだけ。任意native Session API待ちは完成条件から外すが、所有資源回収自体の試験は必要 |
| #86 | 単一所有者WSLのlocal-owner設定と実測。SaaS/tenant/TLS一般は対象外。新設定が実環境で受け入れられるまでOpen |
| #36/#37 | 上記の限定された契約と証拠をまとめる親。設計採択だけで実装完了とはしない |
| PR #40–#47 | 現行mainの代替実装/回帰テストを対応付け、未マージのままsupersededとしてClose。元のbranch/履歴は保持 |
| PR #10 | 診断/Cockpitは#103/#104で代替。旧native同等化/専用ADR publisherは非採用。未完了のローカル要件は#5/#89へ残す |
| PR #99 | 以前停止した試験として未マージでClose。別の成功試験#100と混同せず、元のrefs/状態は削除しない |
| PR #82/#83 | 型だけNode26へ上げる#82は今のNode22/24対応に不要。TypeScript major更新#83は独立の未検証保守提案 |

## 8. 実装状態と受け入れを混同しない

基準mainには、Durable実行・実OAuth/PI WEB・QC直接介入・保存済み成果・実GitHub応答喪失復旧の受け入れがある。しかし、今回追加するlocal-owner設定、ローカル画像/圧縮ストア、Git docsリンク、所有資源の自動回収は、その既存証拠だけでは完成しない。

2026-10-15の開発用一時チェックアウトでは、新設定に関する公開サーバー/厳格モード/操作フェンスの重点26テストが成功し、後続サーバーコードもTypeScriptビルドまで成功した。一方、Journal画面の編集コマンド、および後続の差分/ビルド確認コマンドがツールの安全性チェックで拒否された。拒否理由の詳細は不明。拒否された操作を再表現や別経路で実行しない。

したがって、新しいruntime/UI/回収コードは未コミットの開発状態に留め、**この文書だけのPRには含めない**。新コードの全面回帰・実隔離/実ホスト・破壊的境界試験は未完了であり、#5/#89/#86と親はOpenを維持する。文書PRのCI成功を新コードの成功と呼ばない。所有者の許可やモデル指定の不足ではない。

## 根拠

- [ADR-0018: 責務境界](0018-runtime-deployment-and-evidence-ownership.md)
- [ADR-0019: 能力・受け入れの分離](0019-bounded-product-capabilities-and-issue-disposition.md)
- [実OAuth Quartet受け入れ](../ADR19_DIAGNOSTICS_AND_COCKPIT_ACCEPTANCE.md)
- [実GitHub公開・復旧受け入れ](../HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md)
- [Git Worktreeの公式仕様](https://git-scm.com/docs/git-worktree)
- [Node 22 Zstandard API](https://nodejs.org/download/release/v22.23.3/docs/api/zlib.html)
- [Microsoft WSL networking](https://learn.microsoft.com/windows/wsl/networking)
