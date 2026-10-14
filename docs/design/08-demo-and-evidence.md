# デモと Evidence の読み方

## 結論

Evidence は四区分で読みます。閲覧用固定 fixture は画面再現、Repository 内の受入テスト仕様は期待動作の定義、実操作記録はその日時と対象での観測、E2E 設計は未実施の計画です。これらを混ぜません。fixture の job `done`、Draft PR 表示、評価 score は実 Worker、実 GitHub merge、統計的なモデル精度の証明ではありません。

## 証拠の区分

| 区分 | 目的 | 言えること | 言えないこと |
|---|---|---|---|
| 閲覧用固定 fixture | Firestore に固定状態を置き viewer UI を再現 | 読み取り画面、導線、状態別表示 | 権限付き更新操作、実 AI/Worker/GitHub が履歴を生成したこと |
| 受入テスト仕様 | ケース、前提、期待値、判定法を定義 | 何をどう検査するか | 仕様だけで PASS したこと |
| 実操作記録 | 実 Web/Worker/Cloud Tasks/GitHub/Firestore を観測 | 記録した日時・対象・操作の結果 | 別環境や現在の本番全体の状態 |
| 未実施 E2E 計画 | 将来の一連の手順を定義 | 実施条件、採取すべき Evidence | 実施済み・成功済みであること |

## 固定 seed の位置づけ

Judge demo fixture はインメモリ mock ではありません。viewer の demo login 時に `ensureJudgeDemoWorkspace` が本物の Firestore API を使い、固定 ID の record を既知の閲覧状態へ再設定します。[demo-auth.ts](../../apps/web/src/shared/demo-auth.ts#L771) entity は事前構成済みで、AI、Worker、Cloud Tasks、GitHub API を呼んでその履歴を生成する fixture ではありません。

[UI demo runbook](../demo/ui-demo-runbook.md) は、累積 stage seed で候補、finding、proposal、Draft PR などの固定状態を再現します。seed は実 Worker や GitHub が生成した履歴ではないため、次の表示は UI 再現として評価します。

- proposed/approved RuleVersion の詳細
- open/accepted/resolved DriftFinding
- Draft、verified、mismatch の publication card
- audit、DecisionMemory、Evidence の関連表示
- viewer 用の read-only 導線

seed に含まれる judge score `0.88` と groundedness score `0.91` は固定表示値です。[demo-auth.ts](../../apps/web/src/shared/demo-auth.ts#L479) モデル品質の集計、精度、再現率、合格閾値の実測ではありません。現行 auto policy の既定閾値とも混同しません。

## 閲覧用 judge demo の5分案内

1. `/login` で「デモを見る」を選び、共有された judge 用 ID と password で入ります。
2. viewer として Workspace 概要を開き、閲覧専用ガイドを確認します。
3. 「ずれの検知」で Zod 3→4 の finding、根拠、状態を読みます。
4. 「承認待ち」で proposal、AI 評価表示、人間確認が必要な理由を読みます。
5. 「反映状況」で verified の履歴と open Draft PR を区別し、許可された GitHub リンクから差分を確認します。

demo login 時に固定 sample record を既知状態へ戻すため、複数の閲覧者が同じ案内をたどれます。アカウントは viewer で、Rule の生成・承認、Drift triage、再 compile、GitHub merge はできません。この閲覧経路は外部 AI job や Worker job を呼びません。実生成や merge の証拠は実操作記録で確認します。[Judge デモガイド](../demo/judge-demo.md)

## 検証時の判定

受入確認では、対象 commit、前提、操作、期待値、実結果を記録し、固定 fixture の表示と実接続の結果を分けます。公開されている[初回ルール配布](../usage/first-rule-publication.md)は、解析、承認、Draft PR、人間による merge、反映照合を別々に確認する手順です。手順書そのものは実行成功の証拠ではありません。

判定では次を守ります。

| 表記・状態 | 判定ルール |
|---|---|
| `PASS` | 必須手順と期待値をすべて確認 |
| `BLOCKED` | 環境、role、fixture が不足し全要件を確認不能 |
| `FAIL` | 実施可能な期待値と実結果が不一致 |
| `SKIP` | 任意機能の前提設定が提供されていない |
| job `done` | handler 完了。PR や公開状態は別途確認 |
| `draft_open` | GitHub review 待ち。published ではない |
| `merged` | verify が pending/mismatch の可能性あり |
| `verified` | checked current default commit の blob が一致 |

実 Worker を要するケースで Firestore を直接書き換えて成功扱いにはしません。Publication の受入手順でも「承認済」「compile done」「Draft PR」「merged」「verified」を別状態として扱います。具体的な確認順は[初回ルール配布](../usage/first-rule-publication.md)を参照してください。

## 画面観測と実接続 E2E

[公開マニュアル](../manual/README.md)のスクリーンショットと記述は、記載日時に確認した画面構成の範囲を示します。識別情報、実 Repository 名、内部 ID、詳細な運用記録は公開版に含めません。画面観測から、現在の production 設定、全機能の成功、継続的な稼働を推測しません。

judge 閲覧 fixture、manual の画面観測、実接続 E2E は別の証拠です。judge fixture は公開 demo 用の synthetic record を固定状態へ設定します。manual は匿名化した画面例です。実接続 E2E を実施する場合は、[初回ルール配布](../usage/first-rule-publication.md)に従い、実行結果を公開 source とは別の適切な記録先に保存します。

公開 source に含まれるテストは検証方法を確認する材料ですが、ファイルが存在するだけでは実行済み、PASS、production deploy 済みとはみなしません。結果を主張する場合は、対象 commit と実行環境に結び付いた CI または手元の実行記録を示します。

## Zod upgrade シナリオ

[zod-upgrade-e2e-design.md](../demo/zod-upgrade-e2e-design.md) は Zod 3 の日本語入力エラーメッセージ規約を抽出・承認し、Zod 4 への更新で不整合を検出して規約を改定し、次の AI 開発が改定後の規約を利用できるか確認する設計です。文末に、fixture code は設計例であり、依存導入・実行・GitHub/GCP を通した E2E は未実施と明記されています。

この設計を実施済み Evidence として引用しません。実施する場合は、文書の check list を埋めるだけでなく、次を記録します。

1. 開始時の commit と dependency lockfile
2. bootstrap job と生成候補の Evidence
3. 人間による初回採用
4. 初回 Draft PR と人間 merge、verified commit
5. Zod upgrade commit と DriftFinding の行 Evidence
6. accept、proposal、承認主体
7. 改定 Draft PR の差分
8. 人間 merge 後の current default HEAD と blob verification

## デモで避ける表現

| 避ける表現 | 正確な表現 |
|---|---|
| 「seed で AI が解析した」 | 「AI 解析後を模した固定 Firestore fixture を表示した」 |
| 「job done なので公開した」 | 「job は完了。Draft PR、merge、verify は個別に確認する」 |
| 「Draft PR があるので published」 | 「`pr_open`。人間 merge と verify は未完了」 |
| 「0.88/0.91 の精度」 | 「seed に保存された表示用 score」 |
| 「Zod E2E 済み」 | 「未実施の E2E 設計」 |
| 「本番で auto approval 稼働」 | 「設定が確認できない限り任意機能」 |
| 「merge SHA を検証した」 | 「current default HEAD の対象 blob を検証した」 |

## Evidence の最小セット

judge 向けの主張には、可能なら次を一組で添えます。

- どの区分の証拠か
- 実施日時と対象環境
- 対象 Project/Repository の人間可読名
- 操作者の role と、人間/AI/system/GitHub の actor 種別
- 入力 commit または trigger
- 版として固定した本文・理由・Evidence 参照と、その時点の status
- analysis job の type/status/warning
- Draft PR、merge の有無
- verification の state と checked commit
- PASS/BLOCKED/FAIL と不足条件

内部 ID、個人情報、Workspace 識別子、Repository 内部 ID、credential を本文へ列挙する必要はありません。監査可能性は、相対 source link、時刻、Repository 名、状態、hash など必要最小限の参照で確保します。

## 限界

- seed は破壊的操作なしで UI を再現するための fixture で、運用品質の証明ではありません。
- manual run はその時点の観測であり、継続監視ではありません。
- 受入テストでも環境不足による BLOCKED は残ります。
- screenshot 単独では backend transaction、AI call、GitHub write の由来を証明できません。
- 実 GitHub link、安全な URL、merge、current HEAD verification はそれぞれ別に確認します。
