# 最初のルールをGitHubへ配布する

[GCP構築手順](./gcp-deployment.md) の後に、実際の初回解析から、ルールの承認、GitHub Draft PR、人間によるマージ、反映照合までを確認する。固定seedは使わない。この文書は受入確認の手順であり、実環境での成功記録ではない。

**承認、GitHubへの配布、開発AIによるルール遵守は別の状態である。** この手順の完了は配布ファイルの一致までを確認するもので、開発AIがその指示を守ることまでは保証しない。

## 1. 検証対象と前提

機密情報・実ユーザーデータ・秘密鍵を含まない、自分で管理する検証用Repositoryを1つ用意する。default branchには初回commitが必要で、READMEと実際に解析できる小さなソースコードや設定を置く。より具体的な題材が必要な場合は [Zod更新のE2E検証設計](../demo/zod-upgrade-e2e-design.md) を使う。

作業者はRuleBranchの対象Workspaceで連携・承認を実行できる権限と、GitHubで検証用PRをレビュー・マージできる権限を持つこと。最初の確認はWorkspace ownerで行うと権限を切り分けやすい。閲覧専用の審査用デモやdev-loginでは実施しない。

次を確認してから始める。

- Web / Worker、Cloud Tasks、Scheduler、秘密値、OAuth / Webhookの実URL、Firestore rules / indexesの反映が完了している。必要なcomposite indexは `READY`。
- Workspaceで、解析に必要なコードや抜粋を設定済みAI providerへ送ることへの同意がある。GitHub OAuthログインだけで同意・Repository連携が完了するわけではない。
- 自動承認は `manual` のままにする。初回採用は任意の自動承認を有効にしても人間の担当である。

## 2. WorkspaceとGitHub Appを接続する

WebでGitHub OAuthログインし、利用するWorkspaceを選択する。Workspace IDはアドレスの `/w/<workspaceId>` から確認できる。以降は同じWorkspaceで操作する。

`/w/<workspaceId>/install` を開き、GitHub Appを設定する。GitHub側では **Only select repositories** で検証用Repositoryだけを選ぶ。すべてのRepositoryへのアクセスを選んで進めない。GitHubのセットアップ後にRuleBranchへ戻り、対象Workspaceでinstallationを利用できることを確認する。

「GitHub Appが設定されていません」と出る場合はGCP手順の `github_app_slug` / `GITHUB_APP_SLUG` を確認する。Repositoryが選択肢に出ない場合は、Appの対象アカウント・選択Repository・installationの状態を確認し、再読み込みする。OAuth権限だけを追加して解決しようとしない。

## 3. Projectを作り、初回解析を確認する

「プロジェクト一覧」から新規作成する。URLは `/w/<workspaceId>/projects/new`。Project名、GitHub連携、解析対象の検証用Repositoryを指定し、作成して初回解析を開始する。

Project概要の解析履歴で `bootstrap` jobを特定し、IDと状態を確認する。作成直後の `queued` は受付であり成功ではない。`running` を経て `done` になり、ルール候補と根拠が確認できることを合格条件とする。ポーリング間隔によって `running` の表示を見逃しても、最終的なjob記録で確認できる。

候補が0件の場合は、ジョブ完了とルール抽出成功を混同しない。入力ファイルやjobの警告を調べ、検証用コードを見直して再解析する。seedで候補を足して成功扱いにしない。

## 4. 候補ルールを1件レビュー・承認する

Projectの「ルール」またはWorkspaceの「承認待ち」から、初回解析で作成された候補の版詳細を開く。

本文、適用範囲、L1/L2/L3、強制度、評価方式、rationale、Evidenceのファイル・commit・抜粋が妥当か確認する。初回版には比較対象の承認済み版がない。後続改定では現行版との差分も確認する。根拠不足や警告がある候補を、動作確認のためだけに承認しない。

適切な候補を1件、人間が承認する。RuleVersionが `approved` となり、そのRuleの現行版と判断記録に承認内容が反映されていることを確認する。**この時点ではGitHubへの配布はまだ完了していない。**

## 5. compileとDraft PRを確認する

Projectの「反映状況」（`/w/<workspaceId>/projects/<projectId>/publications`）を開く。対象Repositoryに対する `compile` jobと、生成されたPRを確認する。承認後に対象ジョブが見つからない場合は、権限・対象Repository・生成先を確認し、この画面から生成を再実行する。同じ承認を何度も実行しない。

出力先はRepositoryの `compileTargets` に従う。`agents-md` は `AGENTS.md`、`claude-md` は `CLAUDE.md`、`copilot-instructions` は `.github/copilot-instructions.md`、`rulebranch-rules` は `rulesPath` 配下へ生成する。選択していないファイルが作られることを合格条件にしない。

compile jobが `done`、対象RepositoryのPRが `draft_open` であることを確認し、GitHubでそのPRを開く。期待する承認済みルールが生成され、意図しないルールや秘密情報が混入していないか、既存の手書き部分が保持されているかをレビューする。既存PRがある場合は同じPRが更新されるため、新しいPR番号が必ず発行されるとは限らない。

管理区間や旧生成物の保護で停止した場合は、[既存指示ファイルとの共存・修復](./managed-instructions.md) の手順で、正しいブランチを修復してから再実行する。

## 6. 人間がマージし、反映照合を確認する

GitHubでPRの差分とチェック結果を確認する。Draftの解除を含め、Repositoryの通常のレビュー・マージルールに従い、人間がdefault branchへマージする。RuleBranchの動作確認を理由に保護ルールを解除しない。

RuleBranchの「反映状況」を再読み込みし、対象PRの `merged` に加えて、検証状態が `verified` であることを確認する。`merged` だけでは合格にしない。検証が失敗・未完了の場合は、`publish_verify` job、GitHubのRecent Deliveries、Workerログを確認する。`mismatch` の場合は表示された対象パスと実ファイルを確認し、正当な区間外編集なら再コンパイルして再照合する。単にDBの状態を `verified` へ書き換えない。

必要に応じてGitHubのdefault branchでも対象ファイルを開き、管理区間・承認内容が存在することを確認する。次の開発で利用するときは、開発環境へ最新default branchを取り込み、使用するAIツールの指示ファイル読み込み仕様を確認する。生成したコードの適合性は別途テストする。

## 7. 構築完了の判定と記録

| 確認対象 | 合格条件 |
| --- | --- |
| 初回解析 | 実 `bootstrap` jobが `done`、レビュー可能な候補とEvidenceが存在 |
| 採用 | 人間が承認したRuleVersionが `approved`、現行版・判断記録が一致 |
| 生成と配布準備 | 対象 `compile` jobが `done`、実GitHub PRと想定した生成差分が存在 |
| 配布 | 人間がPRをマージし、RuleBranchで `merged` かつ `verified` |

実施日時、アプリcommit / image digest、Workspace / Project / Repository / job / RuleVersionのID、PR URL、検証commitと結果をprivateな記録へ保存する。公開文書には認証情報や環境固有のIDを追記しない。実接続の結果と固定seedの表示確認を区別する。

## 詰まったとき

| 状態 | 最初に確認する箇所 |
| --- | --- |
| GCPで `queued` が続く | WebのCloud Tasks設定、Queue、OIDCのURL/audience/SA、`jobs-reconcile`。ローカルUI構成とは異なり、そのまま正常扱いしない |
| 解析が `failed` / `dead` | jobのエラー・警告とWorkerログ。AI設定・権限・入力を修正後、画面から新しい解析を実行 |
| 承認済みだがPRがない | 対象Repositoryとcompile job、生成対象、公開エラー。差分がない場合や既存PRの更新も確認 |
| PRがmergedだが未検証 | `pull_request` Webhook、`publish_verify` job、生成物との照合結果 |
| 画面全体がエラー | 必要なindexの存在と `READY`、該当画面のクエリ、Webログ |

インフラの修正は [GCP構築手順](./gcp-deployment.md)、自動承認の監視・未配送回収は [自動評価運用](./automatic-approval.md) を参照する。受入確認が終わるまで自動承認への切り替えや対象Repositoryの拡大を行わない。
