# RuleBranch Usage Guide

このディレクトリは、RuleBranch を動かすための公開向け実行手順をまとめる。特定環境の実行結果や日付付き監査記録は含めない。

| 用途 | ドキュメント | 対象 |
|---|---|---|
| ローカルでUI・Firestore・seedデータを確認する | [local-development.md](./local-development.md) | 開発・デモ・UI確認 |
| Google Cloud上にWeb/Workerを構築する | [gcp-deployment.md](./gcp-deployment.md) | 検証環境・本番相当環境 |
| 最初のルールを承認し、GitHubへの反映まで確認する | [first-rule-publication.md](./first-rule-publication.md) | 構築後の実接続・受入確認 |
| Google評価による自動承認と人間への引き継ぎ | [automatic-approval.md](./automatic-approval.md) | opt-in・shadow検証・監視・停止と復旧 |
| 既存のAI指示ファイルと生成ルールを共存させる | [managed-instructions.md](./managed-instructions.md) | 生成先・管理区間・移行時の保護・修復 |

## まずどちらを使うか

- 画面やデータモデルを確認するだけなら、`local-development.md` の Firestore Emulator + Next.js 構成を使う。
- GitHub App、Cloud Tasks、Worker、Gemini を含めた一連の動作を確認するなら、`gcp-deployment.md` に従って GCP 環境を構築する。構築後は `first-rule-publication.md` で、初回解析、承認、Draft PR、人間によるマージ、反映照合まで確認する。ログイン成功やジョブ作成だけを構築完了の基準にしない。
- ローカル構成では Cloud Tasks の環境変数を設定しないため、Web は `FirestoreRuleStore` を直接利用する。解析ジョブは自動で Worker に配送されないので、UIデモでは `docs/demo/ui-demo-runbook.md` の累積 stage seed で固定状態を再現する。この表示は実 Worker や GitHub の成功証拠ではない。
- Google評価を使う承認ゲートはローカル基本構成には含まれない。GCP構築後に `automatic-approval.md` の手順で、対象Workspaceを限定した `shadow` 運用から開始する。
- 既存の `AGENTS.md` などへ公開する場合は、`managed-instructions.md` で管理区間と停止条件を確認する。

## 実装とドキュメントの対応

- Web: `apps/web`
- Worker: `apps/worker`
- Firestore Emulator / rules / indexes: `firebase.json`, `firestore.rules`, `firestore.indexes.json`
- GCP Terraform: `infra`
- UIデモ: `docs/demo/ui-demo-runbook.md`
- 承認ゲート: [自動承認](./automatic-approval.md)、[ルールのライフサイクル](../design/05-rule-lifecycle.md)、[AI の信頼境界とセキュリティ](../design/06-ai-trust-and-security.md)

各手順の環境変数・Terraform変数は実装を正とする。Web の実行時設定は `apps/web/src/server/bootstrap.ts`、承認ゲートの設定とTerraformリソースはそれぞれ `apps/web/src/shared/approval-policy.ts` と `infra/approval.tf` にある。承認スキャンの集計ログは `apps/web/src/shared/automatic-approval.ts` と `approval-observability.ts` にある。
