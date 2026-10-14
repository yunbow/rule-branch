# 自動評価・人間エスカレーションの運用

## 起動前に確認すること

既定は `manual` であり、更新・デプロイだけでは自動承認しません。既存Rule/RuleVersionの移行や一括承認は不要です。新しい評価メタデータは処理時に付与します。

この機能が自動化するのは、既存の低リスクRuleVersionの承認だけです。Driftのtriage/accept、初回のルール採用、最後のGitHub Draft PRのマージは人間に残ります。

自動承認の候補は、allowlist内でAIデータ利用に同意済みのactiveなWorkspaceに限られる。allowlistは最大20 Workspaceで、各IDは英数字・`_`・`-`の1〜128文字に制限される。さらに、activeなProjectに属する、既存承認版を持つactiveまたはstaleなproject scopeのL3 `guideline` / `coding-style` Ruleのうち、enforcementが `default` または `advisory`、evaluation modeが `semantic` であるものについて、`clarify` または `refactor` の `proposed` 版だけが評価対象になる。Evidence・関連RuleVersion・Drift findingの整合性が不足している場合、実行可能なチェックを持つRule、保護されたRule、警告または切り詰めがある入力はGoogleへ送信せず、人間レビューへ引き継ぐ。

作成直後の提案は競合更新を避けるため2分間評価しない。scanはWorkspaceごとのカーソルで提案を巡回し、1回に全Workspace合計で最大 `RULEBRANCH_APPROVAL_MAX_PER_SCAN` 件、最大240秒まで評価する。allowlistの固定順で上限を共有するため、各scanで全Workspaceが均等に処理される保証はない。

## GCP構築

1. 新しいWeb/Workerイメージをビルドする。評価サービスはWebと同じイメージを使います。ビルドとplatform確認は [GCP構築手順](./gcp-deployment.md) に従います。
2. Vertex AI、Model Armorを利用可能なプロジェクトを用意し、Rule本文・根拠抜粋・関連情報をGoogle評価へ送信することへのWorkspaceの `settings.aiDataUsageConsent=true` を確認する。同意はこの機能から変更しません。
3. Model Armorのテンプレートを作成し、Prompt Injection/Jailbreak検出を有効にする。機密情報を扱う場合はSensitive Data Protection等も設定する。空テンプレートやPI未実行では承認されません。
4. `firestore.indexes.json` のインデックスをデプロイし、必要なindexが `READY` になるまで待つ（`firebase deploy --only firestore:indexes --project YOUR_PROJECT_ID`）。特に `rule_versions.approvalReview.compilePending` を使うインデックスが必要です。デプロイ受付だけでは完了扱いにしません。
5. `infra/terraform.tfvars` に以下を設定して `terraform plan` / `terraform apply`。API有効化・IAM・private Cloud Run・Schedulerは `infra/approval.tf` で管理します。Model Armorテンプレート自体は既存リソースを参照します。

```hcl
approval_mode          = "shadow"
approval_workspace_ids = ["YOUR_WORKSPACE_ID"]
approval_model         = "YOUR_ENABLED_GEMINI_MODEL_ID"
approval_location      = "us-central1"
approval_model_armor_template = "projects/YOUR_PROJECT_ID/locations/us-central1/templates/YOUR_TEMPLATE"
```

評価サービス用の `rulebranch-approval-session-secret` には、公開Webとは別の32 byte以上の値をSecret Managerへ登録する。Secretコンテナの作成順序とversion登録は [GCP構築手順](./gcp-deployment.md) に従う。

モデルIDは、そのプロジェクトで利用可能な具体的なGeminiモデルIDに置き換えてください。判定用モデルを提案生成用モデルと別に設定できます。モデル・評価API・Model Armorの対応リージョンは別々に確認してください。テンプレートが別プロジェクトの場合、そのプロジェクトで評価SAへModel Armor利用権限を付与してください。

評価用 `rulebranch-approval` サービスはpublic Webと別のSAを使い、GitHub App秘密鍵・Webhook秘密鍵・OAuth秘密鍵にはアクセスしません。Cloud RunのinvokerはSchedulerだけです。アプリでもGoogle署名・audience・SchedulerのSAメールアドレスを検証します。Vertex AIとModel ArmorはADCを使用するため、評価サービス向けの新しいAPIキーは不要です。

## 検証してから自動化

まず [初回ルール配布](./first-rule-publication.md) の人間承認経路を確認します。

`shadow` ではすべて人間承認のまま評価値と仮判定を記録します。人間の採否と比較して、特に誤承認候補・高リスク誤分類・根拠不足の見逃しを確認してください。スコア0.95を「95%正しい」と解釈しないでください。

検証後、`approval_mode="auto"` に変更します。対象はallowlist内のWorkspaceだけです。既に `human_required` に移った提案はautoへ変更しても自動的には再承認しません。その提案は既存UIで人間が処理するか、根拠を修正した新しい版を作成してください。

停止時は次の手順を使います。`manual` または空allowlistへの変更は評価用Cloud RunとSchedulerを削除するため、単なる判定モードの切り替えとして扱わないでください。

## 通常停止と未配送データの回収

停止対象のallowlist、現在の評価サービスrevision、作業開始時刻をprivateな運用記録に保存します。評価サービスの削除前に、新しい自動承認が発生しない状態を作り、その後で未配送を確認します。

1. Schedulerからの新規の定期実行を止める。`PROJECT_ID` と `REGION` はGCP構築手順で使用した値です。

   ```sh
   gcloud scheduler jobs pause rulebranch-approval-scan \
     --location="$REGION" --project="$PROJECT_ID"
   ```

2. 停止前に開始した `auto` スキャンについて、下記の構造化ログの `scanId`、Cloud Runのrevision別リクエストログ、Firestoreの `approvalReview.state="evaluating"` とleaseを確認する。pauseは実行中の処理の取り消しではありません。正常完了なら同じscanIdの `approval_scan_completed` を確認します。終了ログがない、タイムアウトした、判定が不明な場合は、経過時間だけで「実行中なし」と扱わず、原因を調べます。必要なら緊急停止へ切り替えます。
3. **対象Workspaceをallowlistに残したまま** `approval_mode="shadow"` で `terraform plan` / `terraform apply`。新revisionの設定がshadowで、サービスの通常URLへのトラフィックがそのrevisionへ向いていることを確認します。旧auto実行が残っていないことも再確認します。Terraform適用でSchedulerのpause状態が変わる可能性もあるため、適用前後の状態を確認してください。
4. shadowでSchedulerを再開し、スキャンを実行する。既存の自動承認に由来するoutboxはshadowでも回収されます。shadowは専用のdrain-onlyモードではないため、未評価の提案はGoogle評価・人間への引き継ぎが発生し得ますが、新たな自動承認は行いません。

   ```sh
   # PAUSEDの場合に再開する。既にENABLEDならresumeは不要。
   gcloud scheduler jobs resume rulebranch-approval-scan \
     --location="$REGION" --project="$PROJECT_ID"
   gcloud scheduler jobs run rulebranch-approval-scan \
     --location="$REGION" --project="$PROJECT_ID"
   ```

   `run` は実行要求の受付であり完了証拠ではありません。Scheduler経由のOIDCを使い、ブラウザや通常のユーザートークンで内部APIを直接呼び出しません。終了ログとFirestoreを確認します。

5. Google Cloud ConsoleのFirestoreで `rule_versions` を検索し、停止対象の**各Workspace**について `ownerWorkspaceId == 対象ID` と `approvalReview.compilePending == true` を条件に、該当が0件であることを確認する。ページを含めて全件を確認し、残っていれば `pendingCompileRepositoryIds`、`evaluationId`、対象Repository、IAM・index・ジョブ作成エラーを調査します。フラグを手動でfalseにして済ませないでください。評価leaseが残っている場合も確認し、期限切れleaseはshadowの次のscanで人間レビューへ引き継がれることを確認します。
6. 作成済みcompile jobのIDと状態を確認する。`compilePending=false` はWorkerの成功やGitHubへの反映完了を意味しません。既にあるqueued jobは既存の `jobs-reconcile` の回収対象です。`dead` jobは原因修正後に「反映状況」から生成を再実行します。
7. 新規auto実行がなく、未配送outboxが0件であることを再確認してから、`approval_mode="manual"` または空allowlistへ変更し、`terraform plan` / `terraform apply`。評価サービスと専用Schedulerが削除され、人間承認のWebと通常Worker / `jobs-reconcile` が維持されることを確認します。

一部Workspaceだけをallowlistから外す場合も、そのWorkspaceの実行中スキャンと未配送を回収してから除外します。除外後はそのWorkspaceのoutboxがscanされなくなります。

## 緊急停止と復旧

誤承認や侵害が疑われるときは、未配送の回収より停止を優先します。Schedulerをpauseし、`manual` または空allowlistを適用して評価サービスを停止します。ただし、停止操作前後に実行中の処理が確定した可能性は残るため、即時停止や承認のロールバックを保証する操作とは扱いません。

停止時刻周辺の監査ログ、`evaluating` のlease、`compilePending=true` の版、作成済みjob、GitHubの未マージPRを記録・確認します。作成済みのcompile jobは評価サービスの停止だけでは取り消されません。疑わしいPRをマージせず、通常の人間レビューで採否を判断してください。

安全なコード・設定へ復旧後、元の対象Workspaceを限定して **shadow** で評価サービスを再作成し、上の未配送回収手順を実施します。ジョブ未作成のoutboxは `jobs-reconcile` だけでは回収できません。Firestoreの承認状態や保存済みハッシュを手作業で成功状態へ書き換えないでください。

## アプリの環境変数

| 環境変数 | 既定 / 内容 |
| --- | --- |
| RULEBRANCH_APPROVAL_MODE | manual / shadow / auto |
| RULEBRANCH_APPROVAL_WORKSPACE_IDS | カンマ区切りの許可Workspace ID。空なら無効、最大20件 |
| RULEBRANCH_APPROVAL_MODEL | 必須。明示的なGeminiモデルID |
| RULEBRANCH_APPROVAL_LOCATION | us-central1 |
| RULEBRANCH_MODEL_ARMOR_TEMPLATE | 完全なテンプレート名 |
| RULEBRANCH_APPROVAL_MIN_JUDGE_SCORE | 0.95（0.9〜1） |
| RULEBRANCH_APPROVAL_MIN_GROUNDEDNESS_CONFIDENCE | 0.95（0.9〜1） |
| RULEBRANCH_APPROVAL_MAX_PER_SCAN | 2（1〜3） |
| RULEBRANCH_APPROVAL_TIMEOUT_MS | 各認証/API処理の上限15000 ms（1000〜20000） |

Google設定不足や利用権限不足は自動承認ではなくhuman_requiredになります。数値範囲やmodeが不正なら起動時エラーにします。PI検査がPARTIAL/SKIPPEDになる場合も人間へ送ります。

## 画面・監査

ナビゲーション「承認待ち」を開き、理由コード・点数・現行版との差分・Evidenceを確認して承認します。`shadow` では `wouldAutoApprove` の結果も記録されますが承認状態は変えません。自動承認版は「承認ポリシーに基づき自動承認」と表示し、人間承認と区別します。

監査actionは `rule_version.auto_approve` / `rule_version.escalate`。評価の生データではなく、モデル名、ポリシー/ルーブリック版、入力ハッシュ、点数、理由コードを確認できます。個別RuleVersionの確定結果は監査記録と `approvalReview` を正とします。

## スキャンの構造化ログ

評価サービスはstdoutへ1行JSONを出力します。開始時は `approval_scan_started`、終了時は `approval_scan_completed`、scan関数から未処理例外が伝播する場合は `approval_scan_failed` です。サーバー生成の `scanId` で開始・終了を対応付け、終了ログには `durationMs`、mode、policyVersionを含めます。強制終了やログ収集障害では終了ログが残らない場合もあるため、Scheduler・Cloud Runのリクエストログと併用してください。

HTTP応答には従来の集計項目が返りますが、**応答bodyがSchedulerの実行履歴やCloud Runのリクエストログへ自動保存される前提では運用しません**。次のアプリケーションログを参照します。

| 項目 | 出力先と意味 |
| --- | --- |
| `reviewed` | 応答・終了ログ。claimした評価対象の件数。Googleへ送信せず人間へ戻した入力も含む |
| `autoApproved` / `humanRequired` / `skipped` | 応答・終了ログ。完了処理の結果またはclaimスキップ。モデルの生の推薦件数ではない |
| `failed` | 応答・終了ログ。候補取得、claim/complete、outbox全体の処理などで捕捉したスキャン内部例外の回数 |
| `compilationDispatches` | 応答・終了ログ。outboxからのジョブ作成・冪等な再配送呼び出しの成功回数。新規jobの実数やWorker成功件数ではない |
| `evaluationFailures` | 終了ログのみ。評価関数が例外となった候補数。設定不足、入力上限、Model Armorブロックも含む |
| `evaluationApiFailures` | 終了ログのみ。上のうち `GOOGLE_API_ERROR` / `GOOGLE_API_UNAVAILABLE` の候補数。API・認証・通信の不成功を区別する。並列APIリクエストごとの失敗総数ではない |
| `evaluationFailureReasons` | 終了ログのみ。許可済みの固定理由コード別の候補数。未知の例外は `EVALUATION_FAILED` に正規化 |
| `compilationFailures` | 終了ログのみ。outbox回収中の個別Repositoryのジョブ作成など、およびflush全体で捕捉した例外回数。再試行による重複を含み、未配送件数ではない |

評価APIが失敗して `human_required` へ正常に引き継がれた場合は、`failed=0` でも `evaluationApiFailures>0` になります。Model Armorによるブロックは `evaluationFailures` と理由コードで区別し、API可用性障害と混同しません。スキャン内部・評価・outboxのいずれかで例外を捕捉した終了ログは `WARNING`、未処理例外は `ERROR`、その他は `INFO` です。

Cloud Tasksへの実配送とWorker実行には別の失敗経路もあるため、これらの集計だけで成功を判定せず、`compilePending`、`analysis_jobs`、反映状況を併せて確認します。ログにはRule本文、Evidence抜粋、Workspace ID、OAuth/OIDC token、provider応答body、例外の生メッセージやstackを出しません。

Cloud Loggingで終了ログを確認する例です。

```sh
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="rulebranch-approval" AND jsonPayload.event="approval_scan_completed"' \
  --project="$PROJECT_ID" --freshness=1h --limit=100 --format=json
```

失敗・実行中の調査では上のevent条件を外し、同じ `jsonPayload.scanId` と `resource.labels.revision_name` を確認します。manual/空allowlistで評価サービスを作っていない場合は、スキャンログ自体が出ないことが正常です。

## テスト

```sh
npm --prefix apps/web ci
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

監視・失敗分類・ログ秘匿・shadowでのoutbox回収の回帰確認だけを行う場合は、Node.js 24で以下を実行します。

```sh
node --test apps/web/test/approval-observability.test.ts
```

```sh
PYTHONPATH=apps/worker/src python -m unittest discover -s apps/worker/tests -v
```

追加テストはGoogle APIをモック化し、実際のAPI課金や承認を発生させません。Firestoreエミュレータ/GCP実環境での接続・IAM・インデックス確認は別途必要です。

## API・運用の一次資料

- Vertex AI評価API: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/evaluation
- EvaluateInstances REST: https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations/evaluateInstances
- Model Armor入出力検査: https://docs.cloud.google.com/model-armor/sanitize-prompts-responses
- SanitizationResult: https://docs.cloud.google.com/model-armor/reference/rest/v1/SanitizationResult
- Model Armor IAM: https://docs.cloud.google.com/model-armor/access-control/roles-permissions
- Cloud Runの構造化ログ: https://docs.cloud.google.com/run/docs/logging
- Schedulerのpause: https://docs.cloud.google.com/sdk/gcloud/reference/scheduler/jobs/pause
- Schedulerの手動実行: https://docs.cloud.google.com/sdk/gcloud/reference/scheduler/jobs/run
