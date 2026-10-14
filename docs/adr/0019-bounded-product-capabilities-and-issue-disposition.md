# ADR-0019: Bounded product capabilities and remaining-issue disposition

- 状態: **設計として採択（このADRのmainへのマージをもって有効）**。以下の将来契約は、実装済みAPIや検証完了の宣言ではない。
- 日付: 2026-10-15
- 対象: #2 / #3 / #4 / #5 / #36 / #37 / #86 / #89
- 調査基準: `7f8ab4a2ca037496a36becab154bcb97ca20ef4b` のコード・lockfile、各Issueの本文と受け入れ条件、既存ADR、公開SDK仕様。
- 関係: ADR-0001/0002/0003/0004/0009/0010/0016/0017/0018を補足する。過去の実装状況欄を現在の事実と混同しない。
- 変更範囲: 設計・担当・受け入れ条件の明文化だけ。実行権限、実行時設定、既存データ、Issueの完了状態は変更しない。

## 1. 結論

**Micromanagerは「誰が、どの証拠と権限で、次に何をしてよいか」を決め、人が直接観測・介入できる小さな制御プレーンとする。Piの実行ループ、PI WEBのホスト管理、OSの隔離、GitのWorktree管理を再実装しない。**

ただし委譲は責任放棄ではない。自分が開始したRun、送った操作、保持を要求した証拠には、正確な識別・許可・終了確認・照合の責任を持つ。相手に必要な公開機能がない場合は「非対応」を返し、安全性を下げて同じ機能に見せない。[R1][R2][E1]

柔軟性とは、あらゆるバックエンドを同じものに見せることではない。**共通の必須契約は小さく保ち、追加能力は明示的に交渉し、実際に検証した組み合わせだけをサポートすること**である。

| Issue | 決定 | このレイヤーで持たないもの |
| --- | --- | --- |
| #2 | Pi Durableを現在の本番対応経路とし、ネイティブPiは明示的な互換アダプターに分離。共通Run契約と実測を整える | 全ランタイムの同等保証、独自OAuth、独自モデルループ、暗黙の経路変更 |
| #3 | フラットな観測・直接介入は製品の中核。PI WEB公開パネル内で完成させる | ホストDOMの横取り、独自認証付き別UI基盤、権限を跨ぐ暗黙集約 |
| #4 | 有限・opt-inの決定論的診断起動ポリシー。自動診断と人による再開を分離 | LLMが自分で権限やQC予算を増やす無限再計画 |
| #5 | 証拠マニフェスト、参照・保留、Journal、レビュー付きADR昇格を製品で扱う。撮影はアダプター | 常時スクリーン録画、汎用バックアップ、他者所有SessionのGC |
| #36 | #85の製品契約と#86の対象ホスト適格性を結ぶ追跡・保証表 | もう一つの隔離エンジン、単一の「全環境安全」フラグ |
| #37 | 実行許可、所有証拠保持、外部ライフサイクル、ハードクォータを別々に追跡 | 全データの一括cleanup、論理上限をハード制限と呼ぶこと |
| #86 | 運用担当が一つの明示的な対象プロファイルを構築・検証。製品は診断と境界契約を提供 | root権限でのOS再構成、カーネル修復、汎用コンテナ管理 |
| #89 | Pi SessionとGit Worktreeを別アダプターで扱う。公開所有元APIと必要証拠のある操作だけ実行 | 生JSONL/SQLite削除、私的HTTP経路、年齢だけによる破壊的GC |

これは8件を一括Closeする判断ではない。設計を採択した時点でも、未実装・未検証の受け入れ条件は残る。実装済みの一部、意図的な非対応、運用作業、将来機能を区別して追跡する。

## 2. 調査で確認した事実と判断の根拠

### 2.1 このリポジトリの実装事実

| 観測 | 確認した根拠 | 設計上の意味 |
| --- | --- | --- |
| `src/core/`はPi/PI WEBに依存しない状態遷移。`ExecutorPort`が実行との境界にある | [R1][R3] | 状態遷移をホストやモデルごとに複製しない |
| 新しいAutopilot設定は`durable`が既定。`production`ではネイティブSessionを拒否する | [R3][R4] | プロバイダー中立性と、全ランタイムの同等サポートは別 |
| Runの`settled`表示や暫定報告だけでなく、保存済み成功結果を遷移境界で検証する | [R4] | LLMの説明は許可・成功判定の代わりにならない |
| 現在の保持処理は自分の派生公開アクティビティ行に限定される | [R5] | 一般的なSession/Worktree削除が完成しているとはいえない |
| Screenshotは既存のQCコミット内ファイルを検証して取り込み、ADRはレビューWorktreeへstageする | [R6] | 撮影・自動PR発行は別機能。取り込みと生成を混同しない |
| 実Pi OAuth/Luna Low・QC Max・PI WEB・GitHub公開復旧の限定的なlive試験は成功した | [R7] | #92の成功をnative経路、4並列QC直接介入、一般運用やGCへ外挿しない |

### 2.2 固定版の公開APIの確認

`npm ci`でlockfileのPI WEB **1.202610.2** / Pi SDK群 **1.2.0**を解決し、配布された`.d.ts`を読んだ。PI WEBのnpm公開メタデータの`gitHead`は `2d65b5f800f832f6f8b866bde493ba1b3763d960`。そのコミットの公開ソースも照合した。今後の最新API一般を推測したものではない。[R8][R9]

- `PiWebHostPiSessionsV1`: `create` / `run`。`run`入力にはmodel/effort指定がない。`completion`は初回入力の結果で、後続ターン全体の証明ではない。
- `PiWebHostPiSessionEventsV1.connect`: `on` / `emit` / `close`。`emit`はfire-and-forgetで、配送ACKや成功結果ではない。`close`は接続を切るがSession自体を止める操作ではない。
- `PiWebHostWorkspacesV1.resolve`: project/workspaceのopaque IDを毎回解決する権限境界。
- `PluginRuntimeContext.archiveSession()`: ブラウザのコンテキスト上の引数なし操作。任意SessionのID・削除前提・操作ID・完了証明を扱う汎用サーバーGC契約ではない。すべてのパネルで利用可能と仮定しない。
- `WorkspaceProvider.prepareRemove()`: **そのWorkspaceを所有するprovider**が、ホストの可視端末実行用planを返す拡張点。planを返したことは削除完了ではなく、別pluginが任意Workspaceを削除してよい権限でもない。
- 公開Workspace/Applicationパネルとnavigationはあるが、アプリ全幅の独自画面や全Workspaceの操作権限が自動で付くわけではない。

「APIが存在する」と「この呼び出し元が対象を安全に操作できる」は別である。以下はこの差を埋める設計判断であり、未公開APIの存在を仮定しない。

## 3. 全Issueに適用する契約

### 3.1 所有権と型付き操作を分ける

共通の業務キーを `(machine, project, orchestra, workflow, task, attempt, run)` とし、`backendId`と外部Session IDを明示的に結び付ける。UIの選択状態やファイルパスだけを実行権限にしない。外部IDの命名・状態は薄いアダプターで翻訳し、DAG/QCポリシーはそこで再実装しない。[R3][R8][E1]

追加能力は、例えば`steer`、`followUp`、`cancelAndInspect`、`readCommittedOutcome`、`retirementPreview`のように操作単位で扱う。これは**提案する論理契約名**であり、現行公開SDKのメソッド名ではない。`supported`だけでなく、バックエンド版・証明範囲・未対応理由を返す。モデルやWorkflowが自己申告した`isolated=true`を採用しない。

すべての副作用には、現在の権限、操作世代、対象ID、期待SHAまたは証拠fingerprint、期限、同一操作IDを結び付ける。遅い事前検査の後にも再確認する。権限喪失時は新規の副作用を止め、処理の終了を確認してから所有権を解放する。[R2][R4]

### 3.2 配送と成功、ローカル原子性と外部原子性を分ける

意味は`requested → acknowledged → completed/failed/uncertain`を区別する。タイムアウト後にACKがないことを、未実行の証拠にしない。同じ操作IDと異なるpayloadは拒否する。再起動でIDを作り直して副作用を再送しない。[R4][E2]

SQLite内の判断・予約・receiptは可能な限り同一トランザクションで整合させる。ただし複数DB、Git、ブラウザ、外部APIまで単一ACID操作になるとは約束しない。予約、実行、結果照合の間で落ちた場合は外部状態を読み、証明できなければ`uncertain`のまま保留する。削除対象が消えたという事実だけで「自分の削除が成功した」と記録しない。[R5][E2][E3]

「exactly once」は観測した試験範囲の性質として扱い、任意のネットワーク分断・外部サービスに対する無条件保証として表示しない。

### 3.3 証拠の段階と失効を表示する

能力の存在、ポリシーによる許可、対象ホストでの実測を別の欄にする。例: `implemented` / `allowed` / `verified-on-profile` / `unsupported` / `not-verified`。構成、依存バージョン、対象root、権限または保証期限が変わったときは影響する証拠を再評価する。署名が正しい証明書でも、古い観測や誤った事実が現在正しいことにはならない。

readinessに`pass`があっても、本番全体が安全と表示しない。入場拒否中も、認可された閲覧、Pause、Abort、照合、容量診断を可能な範囲で維持する。現在の安全側停止と既存の隔離を弱めない。[R2][R4]

## 4. Issueごとの決定

<a id="issue-2"></a>
### 4.1 #2 — 実行アダプター: 共通Run契約とバックエンド別適格性

**決定:** 現行の本番対応は、公開Pi SDKを使うDurable経路と、ホスト所有のLinux隔離・固定Git brokerを基準とする。ネイティブ`pi-web`経路は明示的な互換プロファイルとして維持し、本番拒否を解除しない。新しい環境でDurableが失敗したらnativeへ自動退避することは禁止する。[R3][R4]

プロバイダー/model/effortの選択はホストの許可範囲内のデータとし、Luna/Sol/Astraなどの表示役名を実装分岐や認証方式にしない。今回のLunaの実測はその組み合わせの証拠であり、他の全モデルやnative Sessionまで同等に動作する根拠ではない。[R7]

nativeは `create → subscribe/connect → configure → persisted ACK → prompt` の契約を満たす必要がある。公開busは配送証明を持たないため、companionの相関IDと保存結果の確認をアダプターが担う。既存Runのbackendは固定し、移行は新しいRun/明示的な移行計画として扱う。期限切れleaseだけを見て実行中プロセスやSessionを「未実行」と判定しない。[R8][E2]

**見送る案:** Codex専用のCLIループ、Piを包んだ別のモデル実行ループ、今すぐ全バックエンド向けの汎用plugin基盤、nativeをDurable相当に偽装すること。API境界を狭く維持する方が、SDK更新の影響を局所化でき、既存の状態遷移を共有できる。[R1][E1]

**実装順・受け入れ:** まず共通Run契約の適合テストを、明示ACK、モデル不一致、遅延/重複ACK、配置先不一致、所有権喪失、再起動の各条件で実行する。次に対応するバックエンドごとに、実PI WEBから2つの独立writerと独立QC、設定確認、再起動/重複防止を測る。未提供native能力は拒否・表示までが最低限の互換サポートで、本番対応とはしない。#2の元のnative受け入れを完了させたとはせず、バックエンド別項目として残す。Session/Worktreeの物理回収は#89に一本化する。

<a id="issue-3"></a>
### 4.2 #3 — Cockpit: 製品の中核、ホストの再実装ではない

**決定:** 実Runのフラットな観測と人による直接操作に投資する。`compact/expanded/focused`はRunごとの表示設定で、実行権限やモデルcontextには影響させない。focused inspectorは、まず公開パネル内の選択詳細として実装する。全幅host DOMの横取りや独自Web認証基盤を作らない。[R1][R9][R10]

操作は選択された正確なSession/Runに結び付け、QCへのSteerもplannerを経由させない。実行直前にサーバーが権限・対象世代を再検証する。対象が終わった場合や別scopeへ切り替わった場合に「近い役割の別agent」へ送らない。能力がないボタンは理由付きで無効化する。受信・完了・拒否・不確実を別表示し、接続切断を自動再送の理由にしない。

観測は派生表示であり、永続WorkflowとRun台帳を上書きしない。再接続はsnapshotとcursor/sequenceを照合する。イベントbusがreplayを提供しない場合は、再購読後にscope内snapshotを再取得する。欠落を偽の稼働表示や推定トランスクリプトで埋めない。[R5][R8][R10]

複数projectは、まず公開navigationによるscope切替と認可済みの読み取り専用概要に限定する。横断操作には対象workspaceへの再解決を必要とする。ホストが公開する認可付き集約機能がなければ、隠し経路や全scopeのローカルcacheから集約しない。全幅/別画面は実ユーザーの必要性と公開host能力が確認できたときだけ再検討する。

**見送る案:** 常駐する架空の役名カード、全token/画像の永続複製、plannerが仲介する人間操作、PI WEBのfork、各画面ごとの別Workflow状態。これらは実際の能力と表示を乖離させる。[R1][R10]

**受け入れ:** 実認証付き4並列Runを実ブラウザで表示し、writerをcompact、QCをexpanded/focusedにして、**実行中QCそのもの**へのUI SteerとACKを確認する。ページ切替、終了直前、権限取消、切断、再読込、狭い画面、keyboard操作、他projectへのデータ混入防止も検証する。fauxの4Run成功と、別試験の実認証2Run成功を足してこの受け入れを満たしたことにはしない。

<a id="issue-4"></a>
### 4.3 #4 — 自動診断: 有限ポリシーをcoreに、推論をPiに

**決定:** 診断起動は製品が扱うWorkflowポリシーである。既定はoff、明示opt-inの有限ルールだけを提供する。型付きのQC結果から起動し、自由文の「困った」「もう一度試そう」を自動権限にしない。人間の`held`/Pause/Abortが常に優先する。[R11]

初期対応のルールは次に限定する。以下は設計値であり、現版の設定キーを追加したという意味ではない。

| 軸 | 初期の判断 |
| --- | --- |
| 起動条件 | 保存済みで現在のattempt/SHA/criteriaに一致する、正常完了したQCの明示的な`fail`を所定回数観測した場合 |
| 起動しない条件 | 認証不良、隔離拒否、予算/容量枯渇、実行結果`uncertain`、通信切断、単なる`inconclusive`、人間hold |
| 回数 | 1 Taskにつき自動診断episodeは最大1回。人間の明示的再許可以外でリセットしない |
| 診断構成 | 許可済みプロファイルから2つの独立read-only Runと1つのsynthesisを選択。モデル名は設定データ |
| 予算 | episodeの要求数/時間/出力量/Run数を予約し、Workflow/host総量にも算入。診断失敗で新episodeを無限生成しない |
| 再開 | synthesisは提案だけ。`resume_after_diagnosis`の明示決定まで実装修正・公開を再開しない |

同一QCイベントへの反応を、`(workflow, task, attempt, qcRun, policyRevision)`で一意にする。QC確定と診断hold/予約の競合をWorkflow revisionで直列化し、効果の重複を防ぐ。外部Runの送信は別の段階であり、予約を永続化した後の送信失敗を無条件再送しない。[E2][E3]

2つの診断Runは同じ固定証拠を読み、結論が揃う前に互いの回答を入力しない。「独立」は実行・入力共有の意味であり、同一モデルの誤りが統計的に独立だという保証ではない。片方の失敗や予算切れを多数決で代替せず、人間待ちへ移す。モデルは権限、criteria、QC予算やWorkflowを直接書き換えられない。

**見送る案:** QC失敗ごとに上位モデルを自動呼出し、synthesis後の自動resume、モデル自身によるTask/権限/試行数の増加、自由なルール言語。複雑さと課金を増やし、人間介入の優先性を壊すため。自動診断という機能は残しつつ、実行許可はコードと明示承認に置く。

**受け入れ:** off時に現行動作が変わらないこと。失敗閾値・重複/遅延QC・Pause競合・再起動・片方診断失敗・予算切れで無限起動や早期reworkがないこと。実ブラウザと認証付きPiで、QC中に人間介入→hold→2診断→synthesis→一度だけresumeを示す。#92の最終QC成功は、自動失敗エスカレーションの証拠として流用しない。

<a id="issue-5"></a>
### 4.4 #5 — Journalと知識昇格: 証拠の意味を所有し、生成と削除を分離

**決定:** Journalは限られた事実の投影、artifactは改変検知できる参照、永続的な設計知識は**対象プロジェクトのGitリポジトリ**に置く。Piのnative transcriptやユーザーの画面全体を常時コピーするサービスにしない。[R6][R12]

実装を次の4面に分ける。別microservice群を直ちに作るという意味ではなく、権限と契約の分離である。

1. **Evidence ingestion:** producer ID/version、取得したsource SHA、test/build ID、時刻、内容hash/size、scope、公開可否、retention classを持つマニフェスト。自分が照合した事実とproducerの申告を区別する。
2. **Capture adapter:** 任意機能として、テスト専用ブラウザ/Playwright等が許可済みorigin・scopeで撮影。Micromanagerは依頼と結果を結び付けるが、個人ブラウザのcookie/homeを渡さない。
3. **Projection/retention:** 小さなJournalと選択時の画像取得。thumbnailも独立したhashと元画像参照・変換版を持つ派生物とする。閲覧権限は元のscopeを維持し、画像をモデルへ自動転送しない。
4. **Knowledge promotion:** 人間の明示入力、または有限ルールによるADR候補の提示。候補の生成は権限付与ではない。承認された内容とtargetを固定し、別レビューbranchへのstage/commit/push/draft PR/照合を行う。

現行Screenshot取り込みの「正確なQCコミットにtrackedされたファイル」という契約は維持する。将来の撮影では、画像を必ずGitへ入れる方式だけに限定しない。ただし、**新しいcapture-manifest経路**としてsource SHA・実行test・producer・digestを検証する別の設計/回帰が必要であり、今の取り込み検査を外して未tracked画像を通す実装ではない。画像のhashは内容の同一性で、撮影対象の正しさや秘密除去の証明ではない。[R6]

optional captureは容量不足で抑制可能とする。一方、Taskが画像を必須証拠とする場合、取得失敗を無視してPASSさせない。秘密除去はbest-effortだけで保証せず、取り込み前の運用確認とscope制御を残す。raw診断出力は既存の別ポリシーのまま、Journalへ公開しない。[R5]

hot/warm/permanentは機械的なTTLではなく保持理由として扱う。running/held/uncertain、未確定公開、ADRレビュー中、監査・手動pinを優先する。必須証拠が容量を圧迫したら新規admissionやoptional captureを止め、未解決証拠を勝手に消さない。pinsの棚卸しと人間への通知を提供し、無期限放置と無条件削除の二択にしない。

ADR本文は消えるログだけを根拠にしない。結論、比較案、制約、検証、残る前提を自己完結させ、安定したcommit/PRと最小証拠参照を保存する。codeのQC承認を新しいADR内容の公開承認へ流用しない。対象repo/base/path/content hashへの別承認を必要とし、既存の公開broker/operation-ledgerを再利用する。重複PRは外部照合で防ぐ。stage完了、PR open、merge/採択、rejectを別状態にする。[R6][R13][E2]

**見送る案:** tokenごとのLLM Journal再生成、画面常時録画、汎用blob/バックアップ基盤、native Session削除をartifact TTLへ混ぜること。これらは製品価値より漏洩・保存量・不可逆操作を増やす。

**受け入れ:** 合成Webアプリの画像とtest/sourceリンクがJournalに表示されること、tamper/他scope読取/過大画像の拒否、active/pinned保護とdry-run/確認削除の一致、lost receiptの照合、**実際の対象リポジトリのレビュー用ADR PR**が記録されること。短命な派生物の回収後もADRが理解可能であること。nativeライフサイクルは#89で別証明し、ステージ機能だけで#5全体を完了としない。

<a id="issue-86"></a>
### 4.5 #86 — 運用ホスト: 一つの検証可能なプロファイルに限定

**決定:** 担当は運用/プラットフォーム管理者。製品側は対応プロファイルの契約、読み取り専用診断、有限の無害なprobe手順、evidence schemaを用意する。自動でroot権限取得、cgroup再構成、firewall変更、kernel修復、OS/daemon再起動を行わない。OS固有の低レベル実装をcoreへ入れない。[R2]

最初の本番対象は、明示的に選んだ単一tenantのLinuxプロファイル一つにする。control/provider/publisherは信頼された領域、worker file/shell/testは既存の制限領域として区別する。同じtrustedプロセスで動くprovider/publisherを、文書だけで別credential boundaryと呼ばない。別プロセス資格情報分離が要求される導入先は、その実装・検証が終わるまで未対応とする。[R4]

`cpu.max`、`memory.max`、`pids.max`等のプロセス群に対する制御はOS側の責務。容量scanや単一プロセスのrlimitはその代用ではない。cgroupはファイルアクセス隔離やディスク容量クォータそのものではないので、mount/identity/networkとfilesystem側のクォータも別々に測る。[E4]

導入証拠は、対象host/image ID、software/lock SHA、kernel/runtime版、実効cgroup・filesystem limits、認証/ingress範囲、計測時刻、変更/失効条件と結び付ける。製品内の設定値と、対象で測った値を分離する。未知・古い・driftした保証をverifiedと表示しない。実装されたadmission契約は引き続き安全側に拒否するが、未実装のプロファイル証明検証を実装済みとは書かない。

公開repoのself-hosted CIに開発者の資格情報を自動で渡さない。公開/非公開のrepo区分やEnvironment承認だけでは実行ホストを隔離できない。受け入れ用資格情報を使う試験は、レビュー済みSHA、明示許可、限定targetと清浄な実行環境に分離する。[E5]

**見送る案:** 全Linux/WSL/containerを一括で「サポート」、`production=true`だけで安全と判定、テストを通すための`--no-sandbox`、アプリからOSを修正する万能doctor。範囲を限定した方が証拠を再現できる。

**受け入れ:** 管理者が選んだ実際の対象で、資格情報がworkerのfile/env/networkに届かないこと、資源枯渇時の挙動、子孫停止、所有権復旧、TLS/authz責任、更新と独立reviewを確認する。開発WSLを再起動して試験が通ったことや#92のloopback試験は、導入先の適格性ではない。#86は運用証拠が揃うまでOpenだが、未使用の全導入先を認証するまで製品の文書/コードPRを永久に止めるという意味でもない。

<a id="issue-89"></a>
### 4.6 #89 — ライフサイクル: native Sessionとmanaged Worktreeを独立させる

**決定:** 「自分が作成を要求した」と「物理データの所有元」は別である。Micromanagerは参照・pin・退役候補と許可を扱い、物理変更は対象資源の公開所有元契約へ委譲する。SessionとWorktreeを同一の`delete(path)`へまとめない。[R2][R8][R9]

**Pi/PI WEB Session:** 固定版の公開server capabilityには一般的なarchive/delete/status-with-receiptがない。現時点は在庫、保留理由、正確な対象へ移動する手動案内まで。引数なしのブラウザ`archiveSession()`を、背景の任意Session cleanupとして呼ばない。上流に求める契約は、opaque ID、current generation/lease、停止状態、archive参照/hash、operation ID、実行後inspect/receipt。これは要望であり、存在しないSDK名を実装で呼ぶことは禁止する。

**managed Git Worktree:** Git自身には`worktree list/remove/lock`等があるため、native Session APIの追加まで全Worktree作業を止める必要はない。ただしMicromanagerが作成を記録したexact Worktreeに限定し、Git登録・canonical root・branch/HEAD・dirty/untracked/ignored data・submodule・未公開commit・PR結果・他Run参照・権限を確認する。`--force`、main、他者のworktree、単なる孤立候補、remote branch削除は初期自動回収の対象外とする。[E6]

Gitのclean判定だけで保存価値・未公開変更がないことは証明できない。またMicromanagerのロックは他の手動Git操作を自動では止めない。実行直前の再検査と、所有元の排他的maintenance保証が揃うまで物理回収を許可しない。排他が成立しない環境ではpreview/手動維持に留める。Git登録を持つWorktreeを勝手にrenameして隔離フォルダに移すことも、所有元の修復を壊し得るためしない。

提案する退役プロトコルは `inventoried → proposed → approved → reserved → applied → reconciled`。任意の失敗を`uncertain/retained`へ落とせるものとする。原本/必要証拠のarchiveとhash確認が先、削除意図の永続化が副作用より先、現対象の再確認が最後。削除結果のreceiptと操作履歴は遅延返信や再送の照合期間より長く保持する。対象がないだけで成功を作らず、再起動時に曖昧な削除を再送しない。[E2][E3]

自分の派生公開activityは既存#88の原子的DELETE/receiptを使い、上記の外部退役とは別に扱う。孤立候補の検出は「調査すべき」という事実で、削除許可ではない。保留はまずメタデータ上で行い、他システムの状態を動かさない。[R5]

**見送る案:** ネイティブJSONL/SQLiteの直接削除、private host routeの呼出し、年齢だけのTTL、空の検索結果を削除成功とする処理、Git強制削除。失う証拠と復旧不能性が、回収できる容量に見合わない。

**受け入れ:** SessionとWorktree別に、APIなしの明示拒否、wrong ID、dirty/ignored、active/unsealed/uncertain/pin、競合編集、archive改変、中断、失われた完了応答、再起動、無関係資源の保護を、毎回新規作成したテスト資源だけで検証する。native能力が上流待ちならその項目をblockedとして残し、対応済みWorktreeの部分だけを証拠付きで完了できるよう項目を分ける。#89全体を単なる非対応宣言でCloseしない。

<a id="issue-36"></a>
### 4.7 #36 — 隔離の親Issue: 二つの保証をつなぐ

**決定:** #36自身へ第三の隔離実装を追加しない。製品が強制する#85と、対象で証明する#86をまとめる追跡表にする。各行に「必要な制御」「実装位置」「テスト/対象host」「残る信頼」「失効条件」を持つ。[R2][R4]

#85は完了済みでも、プロセス/credential/tenant境界やハードクォータが対象環境で確認されるまでは#86が残る。逆に、運用側のチェック表だけで製品のWorkspace/世代/停止検査を省略しない。Linux必須機能がない環境で互換実行を安全な代替と呼ばない。

**見送る案:** #36を独立したcontainer schedulerの開発へ膨らませること、CIが緑なら親を即Closeすること、同じ隔離要求を複数Issueへ重複実装すること。

**受け入れ:** 定義した対象プロファイルで#85/#86の全要求と証拠が対応し、未対応範囲を明示する。親の完了はそのプロファイルに限定した適格性であり、全ユーザーの環境を認証した意味にはしない。今は#86が未完了なので#36はOpenのまま。

<a id="issue-37"></a>
### 4.8 #37 — 資源・保持の親Issue: 「一括GC完了」を作らない

**決定:** #87（論理/容量admission）、#88（自分の派生証拠保持）、#89（外部所有元のライフサイクル）、#86（ハードクォータ）の四面を別に追跡する。data ownerと削除権限をUIにも表示する。容量表示とcleanup actionを安易に結合しない。[R2][R5]

full GCが未対応でも、有限なadmissionと選択的なoptional capture、対象を限定した手動運用をサポートできる。ただし止める閾値・保留理由・手順を明示し、容量が尽きるまで無制限に保存する運用や「clear allで復旧」を提供しない。

既存のRun/要求数/期限は維持し、推定金額は監視情報、厳密な請求上限はprovider/運用の制限と区別する。すでに受理された外部要求の料金をAbortで必ず取り消せるとは表示しない。容量の回復は新規admission再検査を可能にするだけで、uncertain Runや操作予約を消す理由にはしない。

**見送る案:** すべてのTTLを一つに揃える、native GCのためにraw filesystem権限を拡大する、論理budgetをcgroupの代わりにすること。外部資源の所有元と失敗モードが違うため。

**受け入れ:** 4面の証拠を別に完成させる。単一の`storageSafe=true`へ潰さず、実装済み・運用済み・上流待ちを示す。#87/#88は維持し、#86/#89の未達が残る間は親#37もOpen。

## 5. 代替案の全体比較

| 案 | 利点 | 採否と理由 |
| --- | --- | --- |
| Pi/PI WEBへすべて任せる | Micromanagerが最小 | 不採用。人間hold、DAG、QC、exact permission、証拠参照の意味はこの製品固有 |
| MicromanagerがUI/runtime/auth/container/GCを全部所有 | 見かけ上一つの製品で完結 | 不採用。攻撃面・維持対象・破壊権限を広げ、既存上流との不整合を増やす |
| 最小共通APIで全backendを同等扱い | 移植を説明しやすい | 不採用。取消・完了証明・隔離・所有権の差が隠れる |
| **小さな業務core＋明示能力を持つ薄いアダプター＋運用証拠** | 差を隠さず置換できる。状態遷移とUIの価値に集中 | **採用**。対応表と契約試験の保守、非対応の説明コストは受け入れる |

## 6. 実装順序と現行からの移行

| 優先 | 単位 | 最小成果物 | 他作業との関係 |
| --- | --- | --- | --- |
| 1 | #2のRun契約/対応表、#3の正確な操作先 | 共通契約試験、backend/能力/状態表示、scopeを誤らない直接介入 | Pi公開APIが変わってもcoreへ広げない |
| 2 | #3の4並列・QC直接Steer、#4の有限診断 | 実UIの限定受け入れ、opt-in診断ルールと停止/再起動回帰 | provider実測は限定構成で実施し全model保証にしない |
| 3 | #5の証拠拡張とADR昇格 | opt-in capture、最小manifest/thumbnail、exact内容承認付きtarget PR | 既存のstageと公開brokerを再利用するが承認は流用しない |
| 4 | #89の資源別退役 | inventory/previewを先行、Worktreeの所有証拠を整え、nativeは公開能力待ち | #88の派生activity保持は止めない。外部削除は保守的に別実装 |
| 並行 | #86の対象ホスト適格性 | 管理者が一つのprofileを指定し、実効制限/権限/復旧の証拠を得る | 本番利用前の運用条件。文書・コード改善を止める理由にはしない |

既存Run、予算、外部操作receiptのbackend/意味を移行時に書き換えない。能力追加は版付きの新規契約として導入し、既存の拒否・許可が暗黙に変わらないようにする。API欠落を私的routeで埋めず、host更新はlockfileとcontract test、必要な実ホスト受け入れを伴わせる。

#5/#89は必要なら親のまま下位項目を段階完了できる。元の受け入れ条件、明確な移管先、採用しない範囲の理由を残す。単に期限のない新Issueへ追い出して親を完了扱いにしない。原要件を変更する場合は、その差分を所有者がレビューする別のscope decisionとする。

## 7. このADRの完了条件と、Issueの完了条件

**このADRの完了:** 8件すべてに、採用範囲・担当・理由・代替案・受け入れ方法・残る前提があり、既存資料と公開APIに整合し、文書検査と通常のコード回帰が通ること。

**各Issueの完了:** 上の個別受け入れを実装・実測し、検証したSHA、API/backend版、試験対象、失敗/skip、外部状態と保証除外を記録すること。設計採択、#92の成功、readiness表示だけで完了にしない。実装しない原要件は、明示承認された移管/非対応判断の履歴なしに取り除かない。

| Issue | このADRで確定するもの | このADRだけでは確定しないもの |
| --- | --- | --- |
| #2 | Durable優先/明示native互換と共通Run契約 | nativeの元の実認証受け入れ、未測定backendの安全性 |
| #3 | 製品中核UX、公開パネル、正確なscope/対象 | 4実認証Run・QC直接Steer・全画面/横断UXの実測 |
| #4 | 自動診断のみopt-in、有限episode、人間resume | 診断policy実装と失敗/再起動時の安全性 |
| #5 | 証拠・capture・ADR昇格・保持の境界 | 新capture/thumbnail、実ADR PR、一般的な物理GC |
| #36 | #85/#86を統合した対象別保証表 | #86の未確認な運用適格性 |
| #37 | #87/#88/#89/#86の分担 | 外部cleanupとハードquotaの完了 |
| #86 | 対象限定の運用検証、製品からのOS変更禁止 | 実デプロイ先の設定・測定・独立review |
| #89 | 所有元別契約、native未対応、Worktree段階対応 | 上流API提供、物理削除/中断照合の実装・証明 |

## 8. 再検討する条件

PI WEBがexact-ID archive/retire/status receiptや認可付き横断パネルを公開したとき、別の隔離backendが必須契約を証明したとき、multi-tenantやcontrol/publisherプロセス分離が実要件になったとき、同一DBへの書込みが実測で限界になったときに再検討する。予測だけで分散schedulerや第二の認証/証拠サービスを増やさない。SDK/providerの更新で既存能力を失った場合は拒否し、黙って意味を下げない。

## 9. 根拠資料

資料を「対象コードの事実」「上流の公開契約」「一般的な仕組みの根拠」に分ける。以下の外部文献は採用案の論拠であり、この製品の試験結果や本番適格性を証明するものではない。参照日: 2026-10-15。

### リポジトリの一次資料

- [R1] [ADR-0001](0001-control-plane-and-product-boundaries.md)、[AGENTS.md](../../AGENTS.md): 決定論的core、人間直接介入、Pi/PI WEB公開契約、資格情報非複製。
- [R2] [ADR-0018](0018-runtime-deployment-and-evidence-ownership.md)、[ADR-0017](0017-production-trust-boundaries.md): 製品/実行基盤/運用と信頼境界。
- [R3] 調査SHAの[ExecutorPort/engine](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/engine.ts)、[runtime設定](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/ledger.ts)、[native companion](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/runtime/companion.ts)。
- [R4] 調査SHAの[server](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/pi-web/server.ts)、[DurableRunHost](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/runtime/durable-runner.ts)、[SECURITY](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/SECURITY.md)。
- [R5] [残存要件の実装対応](../RESIDUAL_ACCEPTANCE.md)、調査SHAの[retention](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/retention.ts)、[registry](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/runtime/registry.ts)。過去ADR-0009の「行がないだけで復旧」記述より、後続#88の原子的receiptを優先する。
- [R6] [ADR-0010](0010-screenshot-artifacts-and-reviewed-adr-staging.md): QC Git blob由来の既存画像の取り込み、lazy preview、別Worktreeへのレビュー済みstage。自動撮影/PRは別。
- [R7] [実認証E2E](../HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md)、[試験PR #100](https://github.com/zkamiyama/pi-micromanager/pull/100)、[実行38594230825](https://github.com/zkamiyama/pi-micromanager/actions/runs/38594230825)。本ADRのための新たなモデル要求は行っていない。
- [R10] [ADR-0004](0004-cockpit-provider-adapters-and-delivery-order.md)、調査SHAの[fleet](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/pi-web/fleet.ts)、[browser](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/pi-web/browser.ts)。
- [R11] [ADR-0002](0002-deterministic-dag-and-live-interventions.md)、[ADR-0005](0005-task-scoped-interventions.md)、調査SHAの[Workflow state machine](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/core/workflow.ts)。
- [R12] [ADR-0003](0003-evidence-journal-retention-and-knowledge.md)、[ADR-0009](0009-journal-and-conservative-retention.md)。過去の「未実装/未検証」は当時の記録で、現在のsource/evidenceと分けて読む。
- [R13] 調査SHAの[publication-service](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/publication-service.ts)、[ADR-0016](0016-audit-control-generation-and-proof-boundaries.md): exact SHA/対象承認、世代fence、曖昧な副作用の照合。

### 固定した上流API

- [R8] PI WEB 1.202610.2の[公開server-plugin-api](https://github.com/jmfederico/pi-web/blob/2d65b5f800f832f6f8b866bde493ba1b3763d960/src/server-plugin-api.ts): Session/Workspace capability、`WorkspaceProvider.prepareRemove`。配布型`dist/server-plugin-api.d.ts`も検査した。
- [R9] 同じ版の[公開plugin-api](https://github.com/jmfederico/pi-web/blob/2d65b5f800f832f6f8b866bde493ba1b3763d960/src/plugin-api.ts): scope/navigation/panels、`PluginRuntimeContext.archiveSession`。配布型`dist/plugin-api.d.ts`も検査した。
- provenance: [調査lockfile](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/package-lock.json)のPI WEB integrityは `sha512-UZ329wWuOzccx3QD+JCyVrGwKFXF6Ss9I2xAEgZMvwHPFTpmirNyBdmoDJD65XeYWQIbNFDkhfjuOqSnOmTcqg==`。`npm view @jmfederico/pi-web@1.202610.2 gitHead dist.integrity --json`とも一致した。

### 一般機構の一次資料

- [E1] Microsoft, [Anti-Corruption Layer pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer): 異なる意味を翻訳境界で分離する。アダプターへ業務ルールを移す根拠や、特定クラウドを導入する要求ではない。
- [E2] AWS Builders' Library, [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/): caller operation ID、同一IDの意図、atomicなreceiptと副作用、遅延要求への備え。本製品の外部操作が自動でその保証を持つという意味ではない。
- [E3] SQLite, [Transaction](https://sqlite.org/lang_transaction.html): 同時readerと単一writer、snapshot/書込み競合。SQLite transactionを外部GitやAPIまでの分散transactionと見なさない。
- [E4] Linux Kernel, [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html): process hierarchyとresource controllers。CPU/メモリ/PID制御をアプリの論理カウンターと区別する。
- [E5] GitHub, [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use): self-hosted runnerとuntrusted code、Environment承認と隔離の違い。
- [E6] Git, [git-worktree](https://git-scm.com/docs/git-worktree): 管理metadata、list/remove/lock、dirty/locked Worktreeの保護、removeとpruneの違い。これだけでアプリのpin/lease/未公開証拠まで保護できるわけではない。

### 残存Issue（2026-10-15確認時点）

[#2](https://github.com/zkamiyama/pi-micromanager/issues/2)、[#3](https://github.com/zkamiyama/pi-micromanager/issues/3)、[#4](https://github.com/zkamiyama/pi-micromanager/issues/4)、[#5](https://github.com/zkamiyama/pi-micromanager/issues/5)、[#36](https://github.com/zkamiyama/pi-micromanager/issues/36)、[#37](https://github.com/zkamiyama/pi-micromanager/issues/37)、[#86](https://github.com/zkamiyama/pi-micromanager/issues/86)、[#89](https://github.com/zkamiyama/pi-micromanager/issues/89)。Issue本文は可変なので、設計根拠には上の固定コード/APIと日付付き観測を併記した。
