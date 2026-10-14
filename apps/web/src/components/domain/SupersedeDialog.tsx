"use client";

import { useState } from "react";
import { ActionDialog, DialogActions, Select, TextArea } from "../ui/index.tsx";

export function SupersedeDialog({
  open, loading, error, rules, onClose, onSubmit,
}: {
  open: boolean;
  loading: boolean;
  error?: string | null;
  rules: { id: string; title: string }[];
  onClose: () => void;
  onSubmit: (id: string, rationale: string) => void;
}) {
  const [id, setId] = useState("");
  const [rationale, setRationale] = useState("");
  const valid = rules.some((rule) => rule.id === id);

  return <ActionDialog
    open={open}
    onClose={onClose}
    title="ルールを統合"
    error={error}
    actions={<DialogActions
      onCancel={onClose}
      onConfirm={() => onSubmit(id, rationale)}
      confirmLabel="統合"
      loading={loading}
      confirmDisabled={!valid}
    />}
  >
    <p>統合先のルールを選択してください。</p>
    <Select label="統合先" value={id} onChange={(event) => setId(event.target.value)}>
      <option value="">選択してください</option>
      {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.title}</option>)}
    </Select>
    <TextArea label="理由" value={rationale} onChange={(event) => setRationale(event.target.value)}/>
  </ActionDialog>;
}
