# ローカル開発環境

RuleBranch の Web UI と Firestore をローカルで動かす手順をまとめる。基本のローカル構成は **Next.js Web + Firestore Emulator** で、GitHub App / Cloud Tasks / Worker / Gemini を必須にしない。

## 1. ローカル構成

```text
Browser
  |
  v
Next.js (apps/web, localhost:3000)
  |
  v
Firestore Emulator (127.0.0.1:8080)
  |
  +-- Emulator UI (localhost:4000)
```

Web は `FIRESTORE_PROJECT_ID` と `RULEBRANCH_SESSION_SECRET` が設定されていると runtime を初期化する。Cloud Tasks 関連の環境変数を設定しない場合は `EnqueueingRuleStore` ではなく `FirestoreRuleStore` を利用するため、解析ジョブは Worker へ自動配送されない。

この基本構成ではGoogle評価による自動承認も実行しない。`RULEBRANCH_APPROVAL_MODE` を設定しても、実際の評価には GCP の認証、Vertex AI、Model Armor、およびSchedulerからだけ到達できる評価サービスが必要である。自動承認の結合確認は [GCP構築手順](./gcp-deployment.md) と [自動評価運用](./automatic-approval.md) で行う。

UI・画面遷移・Rule/Drift/公開状態の確認は seed データで行える。[UIデモランブック](../demo/ui-demo-runbook.md) は累積 stage seed で固定状態を再現する手順であり、Worker の実行結果を再現・証明するものではない。

## 2. 必要なもの

- Node.js 24 以上とnpm（リポジトリのWeb CIはNode.js 24を使用）
- Firebase CLI（以下のセットアップ例は `firebase-tools@15.33.0` に固定）
- Java 21（Firestore Emulator用の基準。`JAVA_HOME` とPATHも同じJDKを指すこと）
- Git

Worker の単体テストも行う場合のみ、Python 3.12 以上も必要。

### Firebase CLIとJavaを準備する

Node.jsとJDKを導入してから、Firebase CLIをインストールする。以下はnpmを利用するため、macOS / Linux / Windows PowerShellで同じコマンドを使える。

```sh
npm install --global firebase-tools@15.33.0
node --version
npm --version
firebase --version
java -version
```

`firebase --version` が `15.33.0`、`java -version` が `21.x` を示すことを確認する。Javaの切り替え後は新しいterminalを開き、`JAVA_HOME` とPATHのずれがないか再確認する。グローバルnpmへの書き込み権限がない場合は、Node.jsのバージョン管理ツールまたは公式の別の導入方法を使用する。

Firebase公式はFirestore EmulatorのJava 21移行を案内している。このため手順ではJava 21を基準とし、古いCLIも含めた一律の最低要件とは扱わない。CLIを更新する場合はリリースノートを確認し、Emulatorの起動とseed投入まで再検証してから、使う完全なバージョンを固定し直す。

このバージョン指定は再現用のセットアップ例であり、すべてのOSでの実機検証済み宣言ではない。現行CIはWebのNode.js 24での検査を行うが、Firebase CLI・Javaを含むEmulator結合確認は別途必要である。実施時のOS、CPU、Node.js、Firebase CLI、Javaの完全なバージョンと結果をprivateな実行記録に残す。

参照: [Firebase CLIのセットアップ](https://firebase.google.com/docs/cli)、[CLIリリースノート](https://firebase.google.com/support/release-notes/cli)、[Firestore EmulatorのJava要件](https://firebase.google.com/docs/emulator-suite/connect_firestore)。

## 3. 依存関係をインストールする

新しいshellでcheckoutのリポジトリルートへ移動する。以降、特記のないコマンドはこの場所から実行する。

```sh
cd /path/to/rule-branch
```

依存関係をインストールする。

```sh
npm --prefix apps/web ci
```

Worker のテストも行う場合は、別途 Python 環境を用意する。

```sh
python -m venv apps/worker/.venv
# macOS / Linux
source apps/worker/.venv/bin/activate
# Windows PowerShell は apps/worker/.venv\Scripts\Activate.ps1
pip install -e apps/worker
```

## 4. Firestore Emulator を起動する

Emulator専用のshellを開き、リポジトリルートで実行する。このshellは起動したままにする。

```sh
firebase emulators:start --only firestore --project rulebranch-demo
```

既定ポートは `firebase.json` の設定どおり以下になる。

- Firestore: `127.0.0.1:8080`
- Emulator UI: `http://127.0.0.1:4000`

起動ログにFirestoreの準備完了が出て、Emulator UIを開けることを確認してから進む。Java不足・ポート競合などで起動に失敗した場合、seedはまだ実行しない。

Emulator を停止するとデータは消える。この手順では `--import` / `--export-on-exit` を使わない。再現性が必要な場合は、起動後に seed を再投入する。

## 5. Web の環境変数を設定する

別のshellを開いてリポジトリルートへ移動し、以下を設定する。seedとWebはこのshellから実行する。実環境用のCloud Tasks・承認ゲート設定をshellや `.env.local` に持ち込まない。

### macOS / Linux

```sh
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIRESTORE_PROJECT_ID=rulebranch-demo
export RULEBRANCH_SESSION_SECRET=local-dev-session-secret-change-me
export RULEBRANCH_DEV_LOGIN=1
```

### Windows PowerShell

```powershell
$env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
$env:FIRESTORE_PROJECT_ID="rulebranch-demo"
$env:RULEBRANCH_SESSION_SECRET="local-dev-session-secret-change-me"
$env:RULEBRANCH_DEV_LOGIN="1"
```

この例の project ID と session secret はローカル専用である。本番環境では固定文字列を使わず、32 byte以上のsecretをSecret Managerから注入する。

`RULEBRANCH_DEV_LOGIN=1` は開発用ログイン API を有効にする。`NODE_ENV=production` では開発ログイン API は 404 になる。

## 6. seed データを投入する

stage を指定すると、その段階までの累積データを投入できる。

```sh
npm --prefix apps/web run seed -- --stage=1
```

全データを投入する場合は stage を省略する。

```sh
npm --prefix apps/web run seed
```

seedスクリプトは接続先のFirestoreへ書き込む。`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` を設定し、Emulatorが起動していることを確認してから実行する。実GCP projectを指定して実行しない。

`Demo seed completed` の出力とEmulator UIのデータを確認する。seedは対象外のrecordを削除しないため、後のstageから前のstageへ戻す場合は、[UIデモランブック](../demo/ui-demo-runbook.md) の初期化手順を先に行う。stageの意味も同文書を参照する。

## 7. Web を起動する

```sh
npm --prefix apps/web run dev
```

ブラウザで以下を開く。

```text
http://localhost:3000
```

## 8. 開発ユーザーとしてログインする

ブラウザの開発者コンソールで以下を実行する。

```js
await fetch("/api/auth/dev-login", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Requested-With": "RuleBranch",
  },
  body: JSON.stringify({
    githubUserId: "1001",
    login: "dev-owner",
  }),
});
```

このAPIは `X-Requested-With: RuleBranch` に加え、ブラウザが送る `Origin` とFetch Metadataも検証する。同じ `http://localhost:3000` のページのコンソールから実行する。

seed の stage に合わせて、必要な Workspace を開く。デモデータでは例として以下を利用する。

```text
http://localhost:3000/w/seed-workspaces-2
```

## 9. ローカル環境で解析ジョブが queued のままになる理由

ローカルの基本構成では、以下の Cloud Tasks 用環境変数を設定しない。

- `GOOGLE_CLOUD_PROJECT`
- `CLOUD_TASKS_LOCATION`
- `CLOUD_TASKS_QUEUE`
- `WORKER_URL`
- `WORKER_SERVICE_ACCOUNT_EMAIL`

そのため Web は Cloud Tasks にジョブを送らず、Firestore への保存だけを行う。`analysis_jobs` が `queued` のままになるのはこの構成では正常である。

UIデモでは、確認したい画面に対応する次の stage の累積 seed を投入する。stage ごとの対象と導線は [UIデモランブック](../demo/ui-demo-runbook.md) を参照する。投入される候補、finding、proposal、Draft PR、job 状態は固定データであり、実 Worker や GitHub の成功証拠ではない。

GitHub App / Cloud Tasks / Gemini / Worker を含む実経路を確認したい場合は、ローカルに無理に再現せず [GCP構築手順](./gcp-deployment.md) と [初回ルール配布](./first-rule-publication.md) を使う。

## 10. GitHub OAuth をローカルで試す場合（任意）

開発ログインではなく GitHub OAuth を利用する場合は、GitHub 側の callback URL を以下に設定する。

```text
http://localhost:3000/api/auth/github/callback
```

そのうえで、Web 起動前に以下を追加設定する。

```sh
export GITHUB_OAUTH_CLIENT_ID=your-client-id
export GITHUB_OAUTH_CLIENT_SECRET=your-client-secret
```

Windows PowerShell の場合は `$env:GITHUB_OAUTH_CLIENT_ID` / `$env:GITHUB_OAUTH_CLIENT_SECRET` を使う。

GitHub App の Webhook をローカルで受ける場合は、GitHub から到達できる HTTPS URL が別途必要になる。通常の UI 開発では不要なので、まず dev-login + seed を使う。

## 11. テスト・静的チェック

### Web

```sh
npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix apps/web test
```

全routeはdynamicで、build時にFirestoreやsessionの資格情報は不要である。

### Worker

```sh
python apps/worker/scripts/lint.py
PYTHONPATH=apps/worker/src python -m unittest discover -s apps/worker/tests -v
```

Windows PowerShell では以下を使う。

```powershell
python apps/worker/scripts/lint.py
$env:PYTHONPATH="apps/worker/src"
python -m unittest discover -s apps/worker/tests -v
```

## 12. よくある問題

### `RuleBranch runtime is not configured`

`FIRESTORE_PROJECT_ID` または `RULEBRANCH_SESSION_SECRET` が未設定。両方を設定して Web を再起動する。

### dev-login が 404

`RULEBRANCH_DEV_LOGIN=1` が設定されているか確認する。また `NODE_ENV=production` では dev-login は無効になる。

### Firestore にデータが見えない

Web と seed の両方で `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` と同じ `FIRESTORE_PROJECT_ID` を使っているか確認する。

### Emulatorが起動しない

`firebase --version` と `java -version` を確認し、手順2のCLI・JDKに合わせる。8080 / 4000番ポートの既存プロセス、CLIのエラーログ、JavaのPATHを確認する。Emulatorを起動できるまで実Firestoreへの接続へ切り替えない。

### Worker が自動実行されない

ローカル基本構成では仕様どおり。Cloud Tasks / OIDC を含む実経路は GCP 環境で確認する。

### 自動承認の結果が作られない

ローカル基本構成では仕様どおり。`approval-scan` はCloud SchedulerのOIDCトークンを検証し、評価はVertex AIとModel Armorを使う。対象Workspaceを限定した `shadow` 運用から、GCP環境で確認する。
