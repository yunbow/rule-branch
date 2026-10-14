# デモと検証

目的に合わせて、次の文書を使います。

| 目的 | 文書 | 確認できること | 確認できないこと |
| --- | --- | --- | --- |
| ローカルで画面を確認する | [ローカル UI デモ](./ui-demo-runbook.md) | Firestore Emulator の固定 seed による画面、状態、導線 | 実 AI、Worker、Cloud Tasks、GitHub の実行 |
| 共有された閲覧環境を案内する | [閲覧用 judge デモ](./judge-demo.md) | viewer UI、固定 fixture、主要な確認順 | fixture が実処理で生成されたこと、Draft PR の公開完了 |
| 実接続した一連の検証を計画する | [Zod 3→4 E2E 検証設計](./zod-upgrade-e2e-design.md) | 実施条件、手順、採取すべき Evidence | 文書だけで実施済みまたは成功済みであること |

固定 seed、実操作記録、未実施の E2E 計画は証拠の意味が異なります。公開説明では、どの区分の結果かを明記してください。実環境の URL、resource ID、credential、内部用の作業記録はこのディレクトリへ追加しません。
