# Google Cloud 構築手順

RuleBranch を Google Cloud 上に構築する手順をまとめる。現在の `infra/` は Terraform で **Cloud Run / Firestore / Cloud Tasks / Cloud Scheduler / Secret Manager / IAM** を作成する。

以下のコマンドはmacOS / Linuxのshell用で、特記がなければcheckoutしたリポジトリのルートから実行する。構築後は [初回ルール配布](./first-rule-publication.md) まで確認し、ログイン成功やリソース作成だけで構築完了としない。

## 1. 構成

```text
GitHub
  | OAuth / App Webhook
  v
Cloud Run: rulebranch-web (Next.js)
  |             |
  |             +--> Firestore
  |
  +--> Cloud Tasks
          |
          v
      Cloud Run: rulebranch-worker (Python / Gemini)
          |
          +--> Firestore
          +--> GitHub API

Cloud Scheduler
  +--> /api/internal/purge-scan        (hourly)
  +--> /api/internal/jobs-reconcile    (every 5 min)

Optional: rulebranch-approval (private Cloud Run, same Web image)
  ^
  +-- Cloud Scheduler --> /api/internal/approval-scan (every minute)
  +--> Firestore / Vertex AI / Model Armor / Cloud Tasks

Secret Manager
  +--> GitHub App private key
  +--> GitHub webhook secret
  +--> Gemini API key
  +--> GitHub OAuth client secret
  +--> RuleBranch session secret
  +--> Approval evaluator session secret (optional, separate trust domain)
```

Web は公開 Cloud Run service とし、アプリケーション側のセッション認証を使う。Worker は public にせず、Cloud Tasks が Worker service account の OIDC token を付けて呼び出す。

## 2. Terraform が作るもの / 作らないもの

### Terraform が作るもの

- Firestore `(default)` database
- 初回起動に必要な一部の Firestore composite index
- Cloud Run `rulebranch-web`
- Cloud Run `rulebranch-worker`
- Cloud Tasks queue `rulebranch-worker`
- Cloud Scheduler jobs
  - `rulebranch-purge-scan`
  - `rulebranch-jobs-reconcile`
- 条件付きの自動承認リソース（`approval_mode` が `shadow` または `auto`、かつ対象Workspaceを指定した場合）
  - private Cloud Run `rulebranch-approval`
  - `rulebranch-approval-scan` Scheduler job
  - 評価専用 service account と Vertex AI / Model Armor / Firestore / Cloud Tasks のIAM
- Service Accounts
  - `rulebranch-web`
  - `rulebranch-worker`
  - `rulebranch-scheduler`
- Secret Manager の Secret コンテナ
- 必要な IAM
- 実行に必要な主要 Google Cloud API の有効化

### Terraform の外で準備するもの

- GCP project と Billing
- Artifact Registry repository
- Web / Worker の container image
- Secret Manager の **secret version（実際の秘密値）**
- GitHub App / GitHub OAuth の設定
- Firestore Security Rules / 全 index manifest の deploy

Secret の値は Terraform state に入れない設計である。`infra/main.tf` は Secret コンテナだけを作り、値は `gcloud secrets versions add` などで投入する。

## 3. 前提ツール

- Google Cloud CLI (`gcloud`)
- Docker（buildxを含む。`linux/amd64` のビルドが可能な環境）
- Terraform 1.6 以上
- Firebase CLI（導入・固定バージョンの例は [ローカル開発環境](./local-development.md) を参照）
- Node.js 24 以上・npm（Firebase CLIと、手順17のホスト上でのWeb検証に使用）
- Git

```sh
node --version
npm --version
firebase --version
docker version
docker buildx version
terraform version
```

container image の build context は必ず **monorepo root** にする。Web / Worker の Dockerfile はどちらもルートの `contracts/` を image にコピーするため、`apps/web` や `apps/worker` を build context にしてはいけない。

Docker image内部の `npm ci` と、ホストの依存関係は別物である。初回のDockerビルドが成功しても、ホストの `node_modules` は作成されない。更新時の検証に必要なホスト側の `npm ci` は手順17で実行する。

## 4. GCP project を準備する

例として以下を使う。

```sh
export PROJECT_ID=your-gcp-project-id
export REGION=asia-northeast1
export AR_REPOSITORY=rulebranch

gcloud auth login
gcloud config set project "$PROJECT_ID"
gcloud auth application-default login
```

Terraform の Google provider は Application Default Credentials (ADC) を利用できるため、ローカル PC から Terraform を実行する場合は `gcloud auth application-default login` を実行する。

Billing が有効な project を使用する。

## 5. Artifact Registry を準備する

`infra/main.tf` は Artifact Registry repository を作らないため、先に作成する。

```sh
gcloud services enable artifactregistry.googleapis.com --project "$PROJECT_ID"

gcloud artifacts repositories create "$AR_REPOSITORY" \
  --repository-format=docker \
  --location="$REGION" \
  --description="RuleBranch container images" \
  --project="$PROJECT_ID"
```

既に repository がある場合は作成不要。

Docker credential helper を設定する。

```sh
gcloud auth configure-docker "${REGION}-docker.pkg.dev"
```

## 6. Web / Worker image を build & push する

Cloud Run向けはホストのCPUにかかわらず **`linux/amd64`** を指定する。Apple Silicon等で指定を省略すると、ビルダーの既定platformに依存したARM64のみのimageを作る場合がある。Cloud Runのコンテナ要件はLinux x86_64で、multi-architecture imageでも `linux/amd64` を含む必要がある。

ARM64ホストでは、Docker Desktopのエミュレーション対応環境またはamd64を実行できるビルダーを使う。`--platform` はエミュレーション環境そのものをインストールしない。`exec format error` などで失敗する場合は、platform指定を外すのではなくビルダーを確認する。

リポジトリルートで実行する。

```sh
export IMAGE_TAG="$(git rev-parse --short HEAD)"
export WEB_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPOSITORY}/rulebranch-web:${IMAGE_TAG}"
export WORKER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPOSITORY}/rulebranch-worker:${IMAGE_TAG}"

docker build --platform=linux/amd64 -f apps/web/Dockerfile -t "$WEB_IMAGE" .
docker build --platform=linux/amd64 -f apps/worker/Dockerfile -t "$WORKER_IMAGE" .

docker push "$WEB_IMAGE"
docker push "$WORKER_IMAGE"
```

pushしたimageをpullし、実際のplatformを確認する。

```sh
docker pull --platform=linux/amd64 "$WEB_IMAGE"
docker image inspect --format '{{.Os}}/{{.Architecture}}' "$WEB_IMAGE"
docker pull --platform=linux/amd64 "$WORKER_IMAGE"
docker image inspect --format '{{.Os}}/{{.Architecture}}' "$WORKER_IMAGE"
```

両方が `linux/amd64` を表示することを確認する。pullに失敗する、または表示が異なる場合はデプロイに進まない。manifestやdigestの確認には `docker buildx imagetools inspect "$WEB_IMAGE"` / `"$WORKER_IMAGE"` も使える。

CIもrepository rootをbuild contextにしている。Web imageはNext.jsのstandalone出力だけを非rootのruntime stageにコピーするため、build用依存を本番imageに含めない。

参照: [Cloud Run container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)、[Dockerのplatform指定](https://docs.docker.com/reference/cli/docker/buildx/build/#platform)。

## 7. GitHub 側で事前に取得する値

Terraform 実行前に、少なくとも以下を用意する。

- GitHub App ID
- GitHub App slug（GitHub App URL `https://github.com/apps/<slug>` の `<slug>` 部分）
- GitHub App private key (`.pem`)
- GitHub webhook secret
- Webログイン用 GitHub OAuth client ID
- Webログイン用 GitHub OAuth client secret
- Gemini API key
- RuleBranch session secret
- Approval evaluator session secret (`approval_mode != "manual"` の場合。Web 用とは別の値)

session secret は例として以下で生成できる。

```sh
openssl rand -base64 48
```

webhook secret は例として以下で生成できる。

```sh
openssl rand -hex 32
```

GitHub App の URL は Web の Cloud Run URL が確定してから最終設定するため、この時点では App ID / private key / OAuth client ID など、Terraform と secret 登録に必要な値を先に確保する。

## 8. `terraform.tfvars` を作る

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

`infra/terraform.tfvars` を以下のように設定する。

```hcl
project_id             = "your-gcp-project-id"
github_app_id          = "your-github-app-id"
github_app_slug        = "your-github-app-slug"
github_oauth_client_id = "your-github-oauth-client-id"

web_image    = "asia-northeast1-docker.pkg.dev/your-gcp-project-id/rulebranch/rulebranch-web:IMAGE_TAG"
worker_image = "asia-northeast1-docker.pkg.dev/your-gcp-project-id/rulebranch/rulebranch-worker:IMAGE_TAG"

# 初回applyだけに使う仮URL。サービス作成後、手順14で取得した実URLに必ず置き換える
web_url    = "https://bootstrap.invalid"
worker_url = "https://bootstrap.invalid"

# 必要な場合のみ上書き
# region                 = "asia-northeast1"
# web_min_instance_count = 1 # 0 は scale-to-zero、1 は cold start を抑制
# ai_model_fast          = "gemini-2.5-flash"
# ai_model_reasoning     = "gemini-2.5-pro"
```

`github_app_slug` は秘密値ではない。GitHub App の公開URLが `https://github.com/apps/rulebranch-example` の場合は `rulebranch-example` を設定する。Web の `/install` 画面は、この値を Cloud Run の `GITHUB_APP_SLUG` 環境変数として受け取り、インストールURLを生成する。

**秘密値は `terraform.tfvars` に書かない。**

Google評価による自動承認を有効化する場合は、通常のWeb/Worker構築を完了してから `automatic-approval.md` の `approval_*` 変数を追加する。`approval_mode = "manual"` または `approval_workspace_ids = []` の間は、評価用Cloud RunとSchedulerは作成されず、既存の人間承認フローだけが動作する。

`*.tfvars` は `.gitignore` の対象だが、秘密値は引き続き `terraform.tfvars` に書かない。

`web_url` と `worker_url` はCloud Run自身のURLを参照する必須変数であり、サービス作成前には確定しない。初回だけ有効なHTTPS形式の仮URLでapplyし、サービス作成後に手順14の `gcloud run services describe` で取得したURLへ置き換えて、もう一度applyする。仮URLのままではOAuth redirect、Scheduler OIDC、Cloud Tasks OIDCが正しく動かないため、構築完了として扱わない。Cloud RunのURL形式から推測した値を使う場合も、利用開始前に `describe` の結果と一致することを確認する。

基本のTerraformは `ai_provider = "gemini-api"` を前提に、Gemini API keyをWorkerへ渡す。Worker実装は `vertex-ai` も選択できるが、基本のTerraformはVertex AI APIの有効化とWorker用IAMを構成しないため、変数だけを切り替えても起動可能な構成にはならない。Vertex AIを使う場合は、それらを別途追加する。

## 9. Terraform 初期化

```sh
terraform -chdir=infra init
terraform -chdir=infra validate
terraform -chdir=infra plan
```

## 10. 初回だけ Secret コンテナを先に作る

Cloud Run は Secret Manager の `latest` version を参照する。一方、秘密値は Terraform 管理外なので、初回構築は次の順序にする。

1. Terraform で API と Secret コンテナを作る
2. Secret version を手動登録する
3. Terraform を通常適用して Cloud Run などを作る

まず以下を実行する。

```sh
terraform -chdir=infra apply \
  -target='google_project_service.required' \
  -target='google_secret_manager_secret.github_app_private_key' \
  -target='google_secret_manager_secret.webhook_secret' \
  -target='google_secret_manager_secret.ai_api_key' \
  -target='google_secret_manager_secret.github_oauth_client_secret' \
  -target='google_secret_manager_secret.session_secret' \
  -target='google_secret_manager_secret.approval_session_secret'
```

新規 project では API 有効化直後の反映待ちにより失敗する場合がある。その場合は、同じ apply を再実行する。

## 11. Secret version を登録する

### GitHub App private key

```sh
gcloud secrets versions add rulebranch-github-app-private-key \
  --data-file=/path/to/github-app-private-key.pem \
  --project="$PROJECT_ID"
```

### GitHub webhook secret

```sh
gcloud secrets versions add rulebranch-webhook-secret \
  --data-file=/path/to/github-webhook-secret.txt \
  --project="$PROJECT_ID"
```

GitHub App 側にも同じ webhook secret を設定する。

### Gemini API key

```sh
gcloud secrets versions add rulebranch-ai-api-key \
  --data-file=/path/to/gemini-api-key.txt \
  --project="$PROJECT_ID"
```

### GitHub OAuth client secret

```sh
gcloud secrets versions add rulebranch-github-oauth-client-secret \
  --data-file=/path/to/github-oauth-client-secret.txt \
  --project="$PROJECT_ID"
```

### RuleBranch session secret

```sh
gcloud secrets versions add rulebranch-session-secret \
  --data-file=/path/to/rulebranch-session-secret.txt \
  --project="$PROJECT_ID"
```

Approval evaluator を有効にする場合は、Web のログインCookie署名鍵を共有せず、別の値を登録する。

```sh
gcloud secrets versions add rulebranch-approval-session-secret \
  --data-file=/path/to/approval-session-secret.txt \
  --project="$PROJECT_ID"
```

秘密値のファイルは所有者だけが読める権限で作成し、登録後は安全に削除する。秘密値をコマンドライン引数やshell historyへ残さない。

## 12. GCP リソースを本適用する

```sh
terraform -chdir=infra plan
terraform -chdir=infra apply
```

Terraform により以下が接続される。

- Web service account → Firestore / Cloud Tasks
- Worker service account → Firestore / Secret Manager
- Web → Cloud Tasks queue
- Cloud Tasks → Worker (`/tasks/analysis-jobs`)
- Scheduler → Web internal endpoints

自動承認を有効化した場合は、さらにScheduler → private `rulebranch-approval` → Firestore / Vertex AI / Model Armor / Cloud Tasks が接続される。評価サービスはWebと同じcontainer imageを使うが、Webのservice account、GitHub App秘密鍵、Webhook秘密鍵、OAuth秘密鍵にはアクセスしない。

新規 project では API propagation の都合で最初の full apply が失敗した場合、内容を確認したうえで `terraform apply` を再実行する。

## 13. Firestore rules / indexes を deploy する

Terraform は Firestore database と初回起動に必要な一部のcomposite indexを作る。`firestore.rules` と、アプリ全体で使うindexを列挙した `firestore.indexes.json` は Firebase CLI でdeployする。

```sh
firebase login
firebase deploy --only firestore --project "$PROJECT_ID"
gcloud firestore indexes composite list --project "$PROJECT_ID"
```

**初回構築でも必要なindexがすべて `READY` になるまで待つ。** manifestと実環境のcollection・field順・sort順を比較し、作成受付だけで次の動作確認へ進まない。必要なindexが `CREATING` / エラーである、または存在しない場合は、作成完了または問題の解決後に進む。特に手順17の `decision_memories` / `audit_logs`、自動承認を導入する場合の `approvalReview.compilePending` に対応するindexも確認する。

RuleBranch の Firestore Security Rules はクライアントからの read/write を全拒否する。Web / Worker は server-side SDK + IAM で Firestore にアクセスする。

Firebase CLI から project が見つからない場合は、既存 GCP project を Firebase project として利用できる状態にしたうえで再実行する。

## 14. Web の Cloud Run URL を取得する

```sh
export WEB_URL="$(gcloud run services describe rulebranch-web \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')"

echo "$WEB_URL"
```

本番 runtime は OAuth を有効にする場合、`RULEBRANCH_PUBLIC_URL` に認証情報を含まない HTTPS URL が設定されていることを起動時に検証する。未設定または HTTP の URL では、Host ヘッダーから OAuth callback / redirect URL を組み立てず起動に失敗する。また、`RULEBRANCH_SESSION_SECRET` は 32 byte 以上が必要である。上記の `openssl rand -base64 48` で生成した値を使用する。

Worker URL も確認する場合は以下。

```sh
gcloud run services describe rulebranch-worker \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)'
```

## 15. GitHub App / OAuth の URL を設定する

`WEB_URL` が確定したら GitHub 側を以下に合わせる。

`infra/terraform.tfvars` の `web_url` と `worker_url` も、上で取得した実URLへ置き換えて `terraform plan` / `terraform apply` を再実行する。planでCloud Runの環境変数とSchedulerのURI・OIDC audienceが実URLへ変わることを確認する。

### GitHub OAuth callback URL

```text
${WEB_URL}/api/auth/github/callback
```

### GitHub App Webhook URL

```text
${WEB_URL}/api/github/webhook
```

### Webhook の edge rate limit

アプリケーションは不正な署名ヘッダーを本文読込前に拒否し、本文も25 MBに制限する。ただし、`sha256=` に64桁の16進数を続けた正しい形式の偽署名は、署名の真偽を判定するため本文全体の読込とHMAC計算が必要になる。Cloud Run のインスタンス上限は費用の上限を抑えるが、正規Webhookの可用性を守るrate limitの代わりにはならない。

必要に応じて外部Application Load BalancerとCloud ArmorでWebhook経路を保護できる。これらは現在の `infra/` の管理対象外である。

### GitHub App Setup URL

```text
${WEB_URL}/setup
```

### GitHub App permissions

MVP の要求権限は以下。

- Repository contents: Read & write
- Pull requests: Read & write
- Checks: Read & write
- Metadata: Read-only

### Subscribe する Webhook events

- `installation`
- `push`
- `pull_request`

GitHub App の **Permissions & events → Subscribe to events** で `Push` が選択されていることを保存後にも確認する。`Pull request` だけでは依存更新の自動 Drift 検出は起動しない。検証用 repository の default branch で `package.json` を更新し、Recent Deliveries の `push` が HTTP 200、対応する `drift_scan` ジョブが作成されることを確認する。このチェックはWebhook受付の確認であり、解析完了や反映完了の確認とは分ける。

RuleBranch はインストール時に対象 repository を明示選択する運用を前提とする。

## 16. 動作確認

### Cloud Run

```sh
gcloud run services list \
  --region="$REGION" \
  --project="$PROJECT_ID"
```

ブラウザで `WEB_URL` を開き、GitHub OAuth ログインを確認する。

### Cloud Tasks

```sh
gcloud tasks queues describe rulebranch-worker \
  --location="$REGION" \
  --project="$PROJECT_ID"
```

### Cloud Scheduler

```sh
gcloud scheduler jobs list \
  --location="$REGION" \
  --project="$PROJECT_ID"
```

以下が存在することを確認する。

- `rulebranch-purge-scan`
- `rulebranch-jobs-reconcile`

自動承認を有効化している場合は、さらに `rulebranch-approval-scan` が存在することを確認する。評価用サービスはprivateのため、ブラウザから直接開かずSchedulerの実行履歴とCloud Runの構造化ログで確認する。HTTP応答bodyがリクエストログへ保存されるとは限らない。集計項目・運用開始・停止方法は [自動評価運用](./automatic-approval.md) を参照する。

### Firestore

Google Cloud Console で `(default)` database が作成されていること、必要なindexが `READY` であること、また RuleBranch 操作後にデータが作成されることを確認する。

### 実際の解析から反映まで

上記は接続の前提確認である。続けて [初回ルール配布](./first-rule-publication.md) を実施する。検証用Repository1件で、実 `bootstrap` jobの `done` と候補・Evidence、人間承認、`compile` jobの `done`、実GitHub Draft PR、人間のマージ、`merged` かつ `verified` までを確認して構築完了とする。

GCP実経路で `queued` が続くことは、ローカルUI構成とは違い正常扱いしない。Cloud Tasks設定、OIDC、Worker、`jobs-reconcile` を確認する。seedを投入して実処理の失敗を置き換えない。

## 17. 更新デプロイ

Firestoreのクエリまたは `firestore.indexes.json` を変更した場合は、Webを切り替える前に必要なインデックスを反映し、状態が `READY` になるまで待つ。インデックス作成の受付だけではクエリを実行できない。Firestore Emulatorやメモリ上のテストでは、本番のインデックス不足を検出できないため、変更した画面が使うクエリを本番データに対して読み取り専用で確認する。

```sh
firebase deploy --only firestore:indexes --project "$PROJECT_ID"
gcloud firestore indexes composite list --project "$PROJECT_ID"
```

特にプロジェクトのルール詳細は、関連する判断記録を取得するために `decision_memories` の `ownerWorkspaceId ASC / projectId ASC / createdAt DESC` インデックスを必要とする。このインデックスがない場合、判断記録が0件でも詳細画面全体がエラーになる。公開ログイン画面の確認だけで更新デプロイを完了扱いにしない。

監査ログ画面・`GET /api/audit-logs` は、`audit_logs` の `ownerWorkspaceId ASC / occurredAt DESC` インデックスを必要とする。定義がmanifestにあっても本番で未作成の場合があるため、更新前に存在と `READY` を確認する。必要なこの1件だけを追加する場合は以下を使い、既存インデックスを削除しない。

```sh
gcloud firestore indexes composite create --project "$PROJECT_ID" \
  --collection-group=audit_logs --query-scope=COLLECTION \
  --field-config=field-path=ownerWorkspaceId,order=ascending \
  --field-config=field-path=occurredAt,order=descending
```

GitHub反映ジョブの失敗時は、ジョブのエラーに含まれるHTTPステータス、メソッド、APIパス、GitHubメッセージとリクエストIDを確認する。Workerは未作成の反映用ブランチをGETの404で判定して作成し、既存ブランチは更新する。修正をデプロイしても `dead` 状態の過去ジョブは自動再開しないため、対象リポジトリの反映状況画面から生成を再実行する。

コード変更ごとに新しいimage tagを付け、既存タグは上書きせず、変更したサービスだけをbuild & pushする。自動承認を有効化している場合、評価サービスは `web_image` を再利用するため、Web更新時の同じ `terraform apply` で評価サービスも新revisionになる。

Webだけを変更した場合はWorkerを再buildせず、`worker_image` は現在稼働中のイメージ参照から変更しない。Web imageをpushする前に本番bundle向けのsmokeも実行する。これらはFirestoreやCloud Tasksへ接続せず、別々に生成されたNext.js runtime/route bundle間のエラー応答と、内部reconcile routeの認証・dispatch配線を確認する。

**ここからの検証はホスト上で実行する。** 別の運用端末で作業する場合も、Node.js 24以上とnpmを準備し、更新対象commitをcheckoutしたリポジトリルートへ移動して、lockfileから依存関係をインストールする。ローカル開発環境を以前に準備していたことを前提にしない。

```sh
node --version
npm --version
npm --prefix apps/web ci
npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build
node apps/web/scripts/verify-built-error-boundary.cjs
node apps/web/scripts/verify-built-job-reconcile.cjs
```

いずれかが失敗した場合はpush/applyに進まない。Docker内部の依存関係をホスト用の代わりには使わない。新しいshellを使う場合は `PROJECT_ID`、`REGION`、`AR_REPOSITORY` も手順4の対象環境へ設定し直す。

```sh
export IMAGE_TAG="$(git rev-parse --short HEAD)"
export WEB_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPOSITORY}/rulebranch-web:${IMAGE_TAG}"

docker build --platform=linux/amd64 -f apps/web/Dockerfile -t "$WEB_IMAGE" .
docker push "$WEB_IMAGE"
```

Workerも変更した場合だけ、同じ新しいtagからWorkerのイメージURLを組み立ててbuild & pushする。

```sh
export WORKER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPOSITORY}/rulebranch-worker:${IMAGE_TAG}"

docker build --platform=linux/amd64 -f apps/worker/Dockerfile -t "$WORKER_IMAGE" .
docker push "$WORKER_IMAGE"
```

pushしたサービスについて、手順6と同じ `docker pull --platform=linux/amd64` と `docker image inspect` の確認を行う。Webだけの更新ならWebだけを検査し、Workerのimage参照を作り直さない。

`infra/terraform.tfvars` の `web_image` を新しい完全なイメージURLへ更新する。Workerも変更した場合だけ `worker_image` も更新して適用する。

```sh
terraform -chdir=infra plan
terraform -chdir=infra apply
```

commit SHAなどの一意なtagを使い、既存tagは上書きしない。イメージの実体を厳密に固定する場合は、push済みイメージのdigestを `web_image` / `worker_image` に指定する。
Webだけの更新では、`terraform plan` で `worker_image` とWorker revisionが変わらないことを確認してから適用する。適用前後のWorker image digestを記録し、意図しないruntime更新がないことも確認する。

更新した画面の認証後の表示と変更した処理経路を検証用Repositoryで確認する。承認・生成・公開に関係する変更は [初回ルール配布](./first-rule-publication.md) の確認基準を使い、既存データを消したり本番Repositoryを試験目的で変更したりしない。

## 18. Secret ローテーション

現在の Cloud Run 設定は Secret Manager の `latest` version を参照する。新しい Secret version を追加しても Terraform の設定値自体は変わらないため、**`terraform apply` だけでは no-op になり、新 revision が作成されない場合がある。**

まず新しい version を追加する。

```sh
gcloud secrets versions add rulebranch-session-secret \
  --data-file=/path/to/new-session-secret.txt \
  --project="$PROJECT_ID"
```

既存 revision の新規 instance は `latest` を解決して新しい値を取得できるが、既存 instance まで確実に切り替えるには新しい Cloud Run revision を作る。通常は次のアプリケーション deploy で新しい image tag に更新し、`terraform apply` して revision を更新する。

緊急ローテーションでアプリケーション変更がない場合も、Cloud Run template の revision が変わる更新を明示的に行い、全 instance を新 revision へ移行する。Terraform 管理外の一時的な `gcloud run services update` を使った場合は、その後 Terraform との差分を解消する。

session secret を変更すると既存ログインセッションは無効になるため、影響を考慮して実施する。

## 19. 削除時の注意

`terraform destroy` は RuleBranch の GCP リソースを削除する。Firestore や Secret Manager のデータを失う可能性があるため、本番・共有環境で安易に実行しない。

自動承認だけを停止する場合はdestroyではなく [自動評価運用](./automatic-approval.md) の停止・outbox回収手順を使う。

検証用 project を完全に廃棄する場合でも、必要な監査データや設定を退避してから実行する。

## 20. 関連ファイル

- `infra/main.tf` — GCP リソース本体
- `infra/variables.tf` — Terraform variables
- `infra/terraform.tfvars.example` — tfvars 例
- `infra/versions.tf` — Terraform / provider version
- `apps/web/Dockerfile` — Web image
- `apps/worker/Dockerfile` — Worker image
- `firebase.json` — Firestore Emulator / deploy 設定
- `firestore.rules` — Firestore Security Rules
- `firestore.indexes.json` — Firestore indexes
- [ローカル開発環境](./local-development.md)
- [初回ルール配布と受入確認](./first-rule-publication.md)
- [自動承認の導入・監視・停止](./automatic-approval.md)
- [既存指示ファイルとの共存・修復](./managed-instructions.md)
