# RuleBranch 実例検証設計：Zod 3→4のルール更新を次の開発へ引き継ぐ

状態: 検証設計。RuleBranch の実装確認日は 2026-10-14。本書は実 Web、GitHub、GCP を通した E2E の成功実績ではない。

## 1. 検証すること

小さな入力検証 fixture で、次の一連の流れを検証する。

1. Zod 3 の日本語エラーメッセージ規約を RuleBranch で抽出し、人間が確認して承認する。
2. 承認済み規約を Draft PR で配布し、人間がマージした後に公開内容を検証する。
3. Zod 4 への依存更新と旧規約の不整合を Drift finding として検出する。
4. 人間が finding と改定案を確認し、Zod 4 向け規約を承認・配布する。
5. 新しい開発セッションが配布済み規約を読み、別の入力項目を正しく実装できるか確認する。

題材は説明用の再現ケースであり、実顧客の障害事例ではない。承認済みは公開済みと同義ではない。RuleVersion の承認、compile、Draft PR、人間によるマージ、default branch 上の検証を別々に記録する。

現行の継続 Drift 検知は、主に `package.json` の依存宣言と承認済みルールを比較する。任意のソース変更から設計意図を常に検出できることを示す実験ではない。

Zod 4 では `invalid_type_error` と `required_error` が削除され、統一された `error` パラメータで置き換える。`error` コールバックでは `issue.input === undefined` により未指定を区別できる。正解確認には [Zod 4 migration guide](https://zod.dev/v4/changelog?id=drops-invalid_type_error-and-required_error) を使う。

## 2. fixture と前提

fixture は専用の検証リポジトリへ置き、業務コードへ追加しない。以下ではリポジトリを `<DEMO_REPO>` と表記する。公開記録には個人名を含むリポジトリ名、内部 ID、資格情報を載せない。

- Node.js 24 以上を使用し、実行時の `node --version` と `npm --version` を記録する。
- Zod `3.25.76` と `4.0.17` はこのケースの再現用固定値であり、最新・推奨版を意味しない。
- GitHub App、Web、Worker、Cloud Tasks、Firestore、AI provider が接続された検証環境を使う。
- [`ui-demo-runbook.md`](./ui-demo-runbook.md) の固定 seed 状態は UI 再現用であり、本検証の E2E 証拠にしない。
- 初回採用と改定は人間が承認する。Drift triage と GitHub merge も人間が行う。
- 操作ユーザーは検証 Workspace の `maintainer` または `owner` とし、GitHub 側でも検証リポジトリの PR をマージできる権限を確認する。閲覧用 judge アカウントは使用しない。
- Workspace の `settings.allowAiAutoProposal` が `false` でないことを確認する。この設定名にかかわらず、finding の採用だけでは提案は生成されず、人間による明示的な生成操作が必要である。
- `agents-md` を compile target に含め、管理区間外の手書き指示が保持されることを確認する。

### 承認モードを固定する

専用の検証環境では、実効的な承認モードを `manual` または `shadow` にし、S1 を始める前に実行記録へ残す。`shadow` は評価値を記録するが、承認は人間が行う。新規環境の既定値が `manual` でも、既存環境の設定を推測しない。

既存の `auto` 環境を使う場合は、他の Workspace の運用を変えず、検証 Workspace を `RULEBRANCH_APPROVAL_WORKSPACE_IDS` の allowlist から外す。設定反映と実行中の評価の終了を確認してから検証用の候補・改定版を作成する。対象版が人間の操作前に自動承認されていた場合は、本書の人間承認条件を満たした成功として扱わない。

記録するのは実効モード、検証 Workspace が自動承認対象か、人間または自動のどちらが各版を承認したかである。内部 ID や設定値の詳細は非公開の実行記録へ残す。設定方法と停止時の注意は [自動評価・人間エスカレーションの運用](../usage/automatic-approval.md) を参照する。

### 監視する依存関係

依存関係の選別には二つの配列がある。`selector.dependencies` はルールの適用対象を絞り、`maintenance.watchDependencies` は変更を監視する依存関係を指定する。メタデータ編集画面は両方を配列として扱い、サーバー側も最大50件の配列として検証する。Worker は依存差分名がどちらかに一致するルールを優先する。本ケースでは対象ルールのいずれかに `zod` があることを確認し、意味の異なる二項目を混同しない。

実装参照:

- [メタデータ編集フォーム](../../apps/web/src/components/domain/RuleMetaEditForm.tsx)
- [ルール更新時の配列検証](../../apps/web/src/shared/rules.ts#L98)
- [依存変更によるルール選別](../../apps/worker/src/rulebranch/drift.py#L94)

## 3. S0: Zod 3 の初期状態

### `package.json`

```json
{
  "name": "rulebranch-zod-demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": { "test": "node --test" },
  "dependencies": { "zod": "3.25.76" }
}
```

### `AGENTS.md`

```markdown
# 開発手順

- 依存導入は npm ci、確認は npm test を使用する。
- 指定された機能だけを実装し、依存バージョンと既存テストを勝手に変更しない。
- 指示が実装環境と矛盾する場合は、矛盾を報告してから対応する。
```

初期ファイルに RuleBranch の管理区間を手作業で作らない。

### `README.md`

```markdown
# 顧客入力検証サンプル

このプロジェクトは Zod 3 を使用する。
必須文字列の日本語エラーは `z.string` の `required_error` と
`invalid_type_error` で指定する。未指定は「<項目名>は必須です」、
文字列以外は「<項目名>は文字列で入力してください」とする。
実装は `src/customer-schema.js`、期待動作は
`test/customer-schema.test.js` を参照する。
```

### `src/customer-schema.js`

```js
import { z } from "zod";

export const customerSchema = z.object({
  name: z.string({
    required_error: "顧客名は必須です",
    invalid_type_error: "顧客名は文字列で入力してください",
  }),
});
```

### `test/customer-schema.test.js`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { customerSchema } from "../src/customer-schema.js";

test("顧客名: 正常値", () => {
  assert.deepEqual(customerSchema.parse({ name: "山田" }), { name: "山田" });
});

test("顧客名: 未指定", () => {
  const result = customerSchema.safeParse({});
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].message, "顧客名は必須です");
});

test("顧客名: 型不正", () => {
  const result = customerSchema.safeParse({ name: 123 });
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].message, "顧客名は文字列で入力してください");
});
```

### `.gitignore`

```gitignore
node_modules/
.env
.env.*
coverage/
```

`npm install` で lockfile を作り、`npm test` の3件成功を確認して default branch へマージする。この時点の default HEAD を S0 として記録する。

## 4. S1: 初回解析、承認、配布

1. RuleBranch で検証用 Project を作り、`<DEMO_REPO>` だけを接続する。
2. bootstrap job の完了、警告、入力切り詰めの有無を確認する。候補数だけで成功判定しない。
3. Zod 3 の日本語エラー規約候補について、本文と引用元のファイル・行を確認する。
4. 候補が不十分なら、人間による修正前後を記録する。候補が出ない場合は初回抽出未達とする。
5. 人間が RuleVersion を承認し、compile job と生成物を確認する。
6. Draft PR で `AGENTS.md` の管理区間と手書き部分の保持を確認する。
7. 人間が PR をマージし、RuleBranch が default branch の現在の HEAD から生成物を取得して `verified` としたことを確認する。
8. 初回配布の検証後、README の Zod 3 規約を「現行の開発規約は `AGENTS.md` の RuleBranch 管理区間を参照する。入力検証の期待動作は `test/customer-schema.test.js` で確認する。」へ人間が置き換える。

RuleBranch が記録する merge SHA と、検証時の default HEAD は区別する。後続 commit がある場合、両者が同じとは限らない。

README の整理は、古い手書き規約と配布された管理規約が次の開発で競合するのを避けるために行う。RuleBranch による自動更新には数えず、旧規約の根拠は S0 の履歴で追跡する。

## 5. S2: Zod 4 へ依存を更新する

初回配布の検証が終わる前に依存を更新しない。

1. `npm install --save-exact zod@4.0.17` で依存と lockfileだけを更新し、旧ソースのテストを実行する。
2. 旧パラメータでは期待した日本語メッセージにならないことを確認し、失敗結果を保存する。
3. `src/customer-schema.js` を次の Zod 4 形式へ移行する。テストの期待値は変えない。
4. 既存3件の成功を確認し、依存、lockfile、ソースを同じ PR で default branch へマージする。マージ後の default HEAD を S2 として記録する。

```js
import { z } from "zod";

export const customerSchema = z.object({
  name: z.string({
    error: (issue) => issue.input === undefined
      ? "顧客名は必須です"
      : "顧客名は文字列で入力してください",
  }),
});
```

この段階では RuleBranch の承認済み本文と管理区間を手作業で直さない。ソースは Zod 4 対応済み、承認済み規約は Zod 3 のままという保守漏れを意図的に作る。

## 6. S3: Drift、改定、再配布

| 段階 | 確認すること |
| --- | --- |
| 依存変更の受付 | push webhook または明示した手動検査から drift scan が開始したか |
| 解析 | Zod の依存差分と旧規約を根拠に対象 finding が作られたか |
| 採否 | 人間が対象 finding の内容・根拠を確認し、「対応対象に追加」で accept したか |
| 生成操作 | accepted の finding で、人間が「提案を生成」を実行し、proposal job が作成されたか |
| 生成結果 | proposal job が `done` で、finding の `proposalVersionId` が指す版が実在し、`proposed` であるか |
| 提案レビュー | proposed version の本文、現行版との差分、引用根拠が妥当か |
| 承認 | 人間が公式資料と実テストを照合して新版を承認したか |
| 配布 | compile が新版を含む Draft PR を作ったか |
| 公開 | 人間のマージ後、現在の default HEAD 上で生成物が verified になったか |

`accept` は finding を対応対象にする操作であり、提案生成を開始しない。採用後に待つだけで次へ進まず、「提案を生成」を明示的に実行する。

proposal job が `done` でも、根拠を検証できず提案版が作られない場合がある。job の完了、対象 finding の `proposalVersionId`、リンク先の実在する版の `status=proposed` と `ruleId`・`driftFindingIds` の対応を別々に確認する。提案がなければ「提案生成未達」と記録して承認へ進まない。`failed` / `dead`、権限不足、`AI_AUTO_PROPOSAL_DISABLED` も成功に数えない。

`FINDING_BASE_VERSION_REQUIRED` または `FINDING_BASE_VERSION_STALE` の場合は、finding が現在の承認版を対象にしているか確認し、必要なら現行版を対象に再検査する。再生成・再検査・人間修正を行った場合は、その理由と回数を初回結果とは分けて記録する。

改定案には「Zod 4 では `error` コールバックを使い、未指定は `issue.input === undefined` で区別する。旧パラメータを新規コードに使わない」という意味を求める。利用者向け日本語メッセージは維持する。

AI が正しい API を無修正で提案するとは仮定しない。公式資料の自動取得も仮定しない。初回提案、承認前の人間修正、修正回数を分けて記録する。

対象 finding が解決しても、他のすべての Drift が解決したとは限らない。finding の解決、RuleVersion の承認、GitHub への公開完了もそれぞれ別の状態である。

## 7. 次の開発へ引き継げたか確認する

S3 の配布を取得した新しい clone または clean checkout で、default HEAD、Zod の実バージョン、`AGENTS.md` 管理区間を確認する。以前の会話や口頭で伝えた正解を持ち込まない新しい開発セッションへ、次だけを依頼する。checkout には比較の共通条件として、S2 で移行した既存の Zod 4 コードが含まれる。

```text
注文入力の検証を追加してください。
src/order-schema.js に orderSchema を named exportしてください。
orderSchema は productName を必須文字列として受け取るZodオブジェクトです。
未指定時は「商品名は必須です」、文字列以外は「商品名は文字列で入力してください」を返してください。
空文字・空白のみは今回の対象外です。
既存の開発規約を確認してください。規約と実装環境に矛盾があれば報告してください。
依存バージョン、既存ソース、既存テスト、指示ファイルは変更しないでください。
```

正解 API は依頼文に書かない。評価側は同じ3ケース（正常値、未指定、型不正）のテストを後から追加する。初回成果物を保存してから実行し、失敗後に修正した場合は初回成功に数えない。

比較する場合は、同じ S2 のコードと lockfileから開始し、指示成果物だけを変える。同じモデル、モデル設定、依頼文、ツール権限を使い、各条件を以前の会話を引き継がない独立セッションで実施する。

| 条件 | 指示成果物 |
| --- | --- |
| A | 旧 Zod 3 規約 |
| B | 人間が作成した Zod 4 規約 |
| C | RuleBranch で改定・配布した Zod 4 規約 |

各条件で、規約の読取り、初回テスト結果、人間修正の有無、修正回数を記録する。成功率や品質向上を主張するには、複数回・複数モデルの事前定義した評価が別途必要である。一件の成功、AI の自己申告、モデルスコアだけを効果の証明にしない。

条件 A でも、checkout にある既存の Zod 4 コードから正しい形式を推測して成功する可能性がある。条件間に差が出なければ、RuleBranch による品質改善はこの比較では確認できなかったと記録する。

## 8. 記録と判定

公開する結果には、環境区分、匿名化した対象、各段階の成否、テスト件数、失敗理由、手動介入の有無を記載する。実際の内部 ID、実行 URL、資格情報、個人名を含むリポジトリ名は公開文書へ記入しない。詳細な実行記録は非公開の別紙で管理し、公開時は匿名化した結果だけを転記する。

次を別々に判定する。

- fixture の Zod 3 テストが3件成功した。
- 依存だけを Zod 4へ変えると、旧規約の期待メッセージを満たさなかった。
- Zod 4形式へ移行後、既存3件が成功した。
- RuleBranch が依存変更をもとに対象 finding を作った。
- 人間が「提案を生成」を実行し、job の完了に加えて対象の proposed 版の実在・紐づきを確認した。
- 改定案が無修正だったか、人間修正を要したか。
- 事前に固定した承認条件が維持され、対象の初回版・改定版を人間が承認した。
- 新版の承認、Draft PR、merge、default HEAD 検証が完了した。
- 新しい開発セッションの初回成果物が新規3件を満たした。

### 本書の snippet 単体確認

2026-10-14 に、リポジトリ外の一時ディレクトリで Node.js 24.18.0 と固定依存だけを使って確認した。

- Zod 3.25.76: 顧客名の3ケースが成功。
- 依存だけを Zod 4.0.17へ変更: 旧パラメータによる期待メッセージの不一致を確認。
- 記載した Zod 4形式: 顧客名の3ケースが成功。
- 同じ形式の注文名実装: 新規3ケースが成功。

これは fixture snippet の単体確認である。RuleBranch の解析、Drift、提案、承認、compile、GitHub公開、GCP実行は行っていない。

## 9. RuleBranch 実装参照

- [初期解析](../../apps/worker/src/rulebranch/bootstrap.py)
- [Drift解析](../../apps/worker/src/rulebranch/drift.py)
- [改定提案](../../apps/worker/src/rulebranch/proposal.py)
- [コンパイラ](../../apps/worker/src/rulebranch/compiler.py)
- [GitHubイベント処理](../../apps/web/src/shared/github-app.ts)
- [手動Drift・提案操作](../../apps/web/src/shared/drift.ts)
- [既存指示との共存](../usage/managed-instructions.md)
- [GCP構築](../usage/gcp-deployment.md)
