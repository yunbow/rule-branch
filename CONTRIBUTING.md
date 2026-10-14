# RuleBranch へのコントリビューション

Issue や Pull Request を歓迎します。変更前に、関連する設計と利用手順を
[設計ガイド](./docs/design/README.md) と [利用ガイド](./docs/usage/README.md) で確認してください。
セキュリティ上の問題は公開 Issue ではなく [SECURITY.md](./SECURITY.md) の手順で報告してください。

## 開発環境

Web には Node.js 24 以上、Worker には Python 3.12 以上を使います。
ローカル UI の起動手順は [ローカル開発環境](./docs/usage/local-development.md) を参照してください。

Web の依存関係をインストールします。

```bash
npm --prefix apps/web ci
```

Worker を変更する場合は仮想環境を用意します。

```bash
python -m venv apps/worker/.venv
source apps/worker/.venv/bin/activate
pip install -e apps/worker
```

## 変更時の方針

- ルールの状態遷移、権限、Workspace 境界を変更するときは、拒否される経路も確認する。
- AI 出力を信頼済み入力として扱わず、schema、根拠、上限、失敗時の挙動を維持する。
- compiler の出力は決定論的に保ち、既存ファイルの管理区間と競合検知を壊さない。
- UI、Worker、共有 contract の変更が互いに整合するか確認する。
- 新しい秘密値や実環境の ID を commit しない。
- 挙動を変えた場合は、利用者向け文書も同じ Pull Request で更新する。

## 検査

変更した範囲に応じて、関連する検査を実行してください。

### Web

```bash
npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix apps/web test
```

### Worker

仮想環境を有効にして依存関係をインストールした後に実行します。

```bash
python apps/worker/scripts/lint.py
PYTHONPATH=apps/worker/src python -m unittest discover -s apps/worker/tests -v
```

### Terraform

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

権限、状態遷移、永続化、公開処理を変更する場合は、変更前に失敗し、変更後に通る回帰テストを追加してください。
文書だけの変更では、リンク、見出し、コード例を確認してください。
CI では、このほかに依存関係検査、監査、build 後 route の smoke test、Web / Worker コンテナ build を行います。
ローカル確認のために実環境への deploy や `terraform apply` を行う必要はありません。

## Pull Request

1. リポジトリを fork する。
2. fork したリポジトリで作業 branch を作る。
3. 必要な変更と検査を行い、内容が分かる単位で commit する。
4. 元のリポジトリへ Pull Request を作る。

Pull Request には、解決する問題、利用者から見た変更、主な設計判断、実行した検査を記載してください。
画面や API の挙動を変える場合は、再現手順または具体的な before / after を添えてください。
大きな変更は、実装前に Issue で目的と範囲を共有するとレビューしやすくなります。

GitHub へ配布する RuleBranch 生成物を変更した場合は、Draft PR、人間による merge、
default branch 上の検証という境界を保ってください。
