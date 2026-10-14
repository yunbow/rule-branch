# 閲覧用 judge デモ

共有されたデモ URL と認証情報を使い、RuleBranch の主要画面を短時間で確認するための案内です。URL、ID、password は運用担当者から別経路で受け取ってください。この文書には本番 URL、共有 credential、Cloud resource ID、デプロイ SHA を記録しません。

## 5分で確認する

1. `/login` で「デモを見る」を選び、共有された ID と password でログインします。
2. Workspace の案内を読み、デモアカウントが `viewer` で閲覧専用であることを確認します。
3. 「ずれの検知」で Zod 3→4 の finding、Evidence、状態を確認します。
4. 「承認待ち」で改定提案、AI 評価、人間確認が必要な理由を確認します。
5. 「反映状況」で verified の履歴と open の Draft PR を区別し、生成物を確認します。

ログイン時、アプリは固定 ID の sample record を Firestore の既知状態へ再設定します。そのため、画面上のアカウントは変更操作を拒否しますが、ログイン処理まで含めてデータベースが read-only という意味ではありません。

表示される job、finding、score、提案、生成物は閲覧用 fixture です。ログインによって AI、Worker、Cloud Tasks が実行され、その履歴が生成されるわけではありません。Draft PR 表示も、それだけで公開完了を意味しません。実処理の証拠は、対象と日時を明記した別の実行記録で確認します。

## 運用者向け設定

このログインを有効にする Web runtime では、通常の Firestore と session 設定に加えて次の環境変数が必要です。

```text
RULEBRANCH_DEMO_LOGIN_ENABLED=1
RULEBRANCH_DEMO_LOGIN_ID=<shared-id>
RULEBRANCH_DEMO_LOGIN_PASSWORD=<shared-password>
```

本番では password は12文字以上が必要です。credential はソースや Terraform state に保存せず、秘密情報の管理基盤から runtime へ渡し、公開期間の終了後に無効化またはローテーションしてください。

Terraform で optional demo login を初めて有効にするときは、次の順序で反映します。

1. `demo_login_enabled = true` と共有 ID を設定し、demo password 用 Secret コンテナと Web の参照権限を先に作成します。
2. password を履歴に残さない方法で Secret version として登録します。保護した一時ファイルを使う場合は、登録後に安全に削除します。
3. 通常の plan で Web service がその Secret version を参照することと、意図しない resource の変更がないことを確認してからサービスへ反映します。

Secret version がない状態で Web service まで反映すると、Cloud Run の新しい revision は起動できません。既存環境の構築、Secret の基本的な扱い、plan/apply の確認事項は [Google Cloud 構築手順](../usage/gcp-deployment.md) を参照してください。demo login は optional resource なので、既存の必須 Secret と同じ初回 bootstrap に含まれるとは限りません。

必要に応じて、検証用の HTTPS origin を引数に smoke script を実行できます。実行前に、ID と password をそれぞれ `RULEBRANCH_DEMO_LOGIN_ID`、`RULEBRANCH_DEMO_LOGIN_PASSWORD` へ、shell history に値を残さない安全な方法で設定してください。次の URL は検証先の origin に置き換えます。

```sh
node apps/web/scripts/verify-judge-demo.mjs https://rulebranch.example
```

この確認はログイン、viewer role、主要ページと固定表示を検査します。実 AI 解析や GitHub publication の E2E 検証ではありません。
