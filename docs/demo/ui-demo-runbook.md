# ローカル UI デモ

固定した Firestore fixture を使い、RuleBranch の画面と状態別表示をローカルで確認する手順です。この手順は AI、Worker、Cloud Tasks、GitHub App を実行しません。seed に含まれる job、Evidence、改定提案、Draft PR は表示確認用の固定データです。

## 前提

Node.js 24 以上、npm、Firebase CLI、Firestore Emulator を実行できる Java runtime、Git を準備してください。導入・接続確認と Windows PowerShell の設定は [ローカル開発環境](../usage/local-development.md) を参照してください。

```sh
node --version
npm --version
firebase --version
java --version
```

各 terminal は新しく開き、checkout したリポジトリのルートへ移動します。以下のコマンドは macOS / Linux の shell 用です。実環境の Cloud Tasks や認証設定を持ち込まず、ローカル専用の Emulator を使ってください。

## 起動

リポジトリのルートから Web の依存関係をインストールします。

```sh
npm --prefix apps/web ci
```

別の terminal で Firestore Emulator を起動したままにします。

```sh
firebase emulators:start --only firestore --project rulebranch-demo
```

Web 用の terminal で Emulator 接続とローカル認証を設定し、seed を投入して起動します。

```sh
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIRESTORE_PROJECT_ID=rulebranch-demo
export RULEBRANCH_SESSION_SECRET=local-dev-session-secret-change-me
export RULEBRANCH_DEV_LOGIN=1
npm --prefix apps/web run seed
npm --prefix apps/web run dev
```

`seed` は指定された Firestore に書き込みます。`seed-demo.ts` は `FIRESTORE_EMULATOR_HOST` がなければ停止し、`NODE_ENV=production` でも停止します。それでも、実行前に接続先が Emulator であることを確認してください。上記の session secret と開発ログイン設定はローカル専用です。

ブラウザで [http://localhost:3000](http://localhost:3000) を開き、そのページと同じ origin の開発者コンソールで次を実行します。開発ログイン API は `GET` ではなく、`X-Requested-With` を付けた `POST` です。

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

ログイン後、[Demo Organization](http://localhost:3000/w/seed-workspaces-2) を開きます。

## 段階別の固定データ

特定の表示だけを確認するときは、次の初期化手順を完了してから stage を指定して seed を入れ直します。seed は対象 record の保存・上書きだけを行い、対象外の record は削除しません。全件投入後に `--stage=3` を実行するだけでは、stage 4 以降のデータが残ります。

### Emulator を初期化して入れ直す

この手順はローカル Emulator の全データとセッションを破棄します。保存が必要なローカルデータがないことを確認し、実 GCP 環境には実行しないでください。

1. Web 用 terminal の `npm run dev` を `Ctrl+C` で停止します。
2. Emulator 用 terminal も `Ctrl+C` で停止します。
3. Emulator 用 terminal のリポジトリルートから、`--import` や `--export-on-exit` を付けずに、空の Emulator を起動します。

   ```sh
   firebase emulators:start --only firestore --project rulebranch-demo
   ```

4. Web 用 terminal で接続先を設定し直し、目的の stage だけを投入して Web を再起動します。以下は stage 4 の例です。

   ```sh
   export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
   export FIRESTORE_PROJECT_ID=rulebranch-demo
   export RULEBRANCH_SESSION_SECRET=local-dev-session-secret-change-me
   export RULEBRANCH_DEV_LOGIN=1
   npm --prefix apps/web run seed -- --stage=4
   npm --prefix apps/web run dev
   ```

5. ブラウザで `/login` を開き、上記の開発ログイン用 `POST` を再実行してから Demo Organization を開きます。初期化前のセッションは使えません。

別の stage に切り替える場合も、同じ手順で初期化し、`--stage=4` を目的の値に置き換えます。

### stage の内容

stage は累積です。たとえば stage 3 は stage 1 と 2 のデータも含みます。各 stage は同じ item を操作に応じて順次遷移させる仕組みではなく、その段階で必要になる別々の固定 record を追加します。stage を省略すると全データを投入します。

| stage | 追加される主な固定データ | 確認する画面 |
| --- | --- | --- |
| 1 | Workspace、メンバー、installation、Project、Repository、初回解析候補、queued/done job | Workspace、プロジェクト、ルール |
| 2 | running、done、failed、dead の解析 job | プロジェクトの履歴 |
| 3 | dependency update trigger、open/dismissed finding、Evidence、stale rule | ずれの検知 |
| 4 | 提案未作成の accepted finding と、その finding 専用の Evidence | ずれの検知 |
| 5 | 別の accepted finding、そこに紐づく proposed RuleVersion・Evidence・完了した proposal job | ずれの検知、ルール版の詳細 |
| 6 | approved/superseded/rejected/withdrawn などの別 fixture、組織ルールとその承認版、版履歴と関係表示用データ | ルール、版の詳細、関係 |
| 7 | resolution snapshot、生成物、Draft/merged/verified/mismatch の publication fixture | 反映状況 |

stage 4 の「対応対象に追加済み・提案未作成」は `proposalVersionId=null` で、同じ stage にある Evidence を参照します。stage 5 の「提案生成デモ」とは別の finding であり、stage 5 以降も提案未作成の fixture はそのまま残ります。「提案を見る」は実在する固定の提案版へ移動しますが、「提案を生成」「再生成」による実処理の成功は、この UI デモの確認対象ではありません。

stage 6 は stage 5 の提案を自動承認した結果ではありません。承認、却下、撤回などの表示を確認するための別 fixture です。

## 確認の流れ

1. Workspace とプロジェクトを開き、固定された初回解析候補と job 状態を確認します。
2. 「ずれの検知」で dependency update、Evidence、open/accepted/dismissed の finding を確認します。
3. ルールと版の詳細で proposed、approved、superseded などの表示、根拠、関係を確認します。
4. 「承認待ち」でレビュー対象と状態別表示を確認します。
5. 「反映状況」で Draft、merged、verified、mismatch と生成物一覧を確認します。

stage 7 の PR URL と Git 情報は mock です。実 GitHub PR、実際の merge、公開検証の証拠として扱わないでください。ローカル基本構成では解析 job は Worker に配送されません。実際の解析と GitHub 連携は [Google Cloud 構築手順](../usage/gcp-deployment.md) に従う別環境で確認します。

## seed の回帰テスト

実際に投入する fixture の生成は `apps/web/scripts/seed-fixtures.ts`、stage の選別は `seed-stage.ts`、Firestore への書き込みは `seed-demo.ts` に分離しています。次のテストは Firestore や認証情報なしで実行でき、stage 1〜7 の参照整合性、提案未作成と提案済みの区別、累積性、seed の接続先・本番実行ガードを確認します。

```sh
node --test apps/web/test/ui-013.test.ts apps/web/test/seed-fixtures.test.ts
```

これは fixture とガードの単体確認です。Emulator への書き込み、ブラウザ表示、実接続 E2E の成功を証明するものではありません。

## 記録

実施日時、画面幅、結果、スクリーンショットは private な実行記録へ保存してください。この公開文書には実環境の URL、resource ID、認証情報を追記しません。公開する結果は対象を匿名化し、固定 fixture の画面確認と実接続 E2E の結果を区別します。
