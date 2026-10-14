"use client";

import { TextArea } from "../ui/index.tsx";

export function ChecksJsonField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}) {
  return <div className="formGroup">
    <TextArea
      label="実行チェック（JSON）"
      value={value}
      placeholder={'[{"kind":"regex","spec":{"pattern":"^foo$"},"severityOnFail":"error"}]'}
      onChange={(event) => onChange(event.target.value)}
    />
    <small className="formHint">決定的評価では、ルールを検証するチェック定義が必要です。</small>
    {error && <p role="alert" className="formError">{error}</p>}
  </div>;
}
