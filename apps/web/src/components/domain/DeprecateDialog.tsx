"use client";

import { useState } from "react";
import { ActionDialog, DialogActions, TextArea } from "../ui/index.tsx";

export function DeprecateDialog({
  open, loading, error, onClose, onSubmit,
}: {
  open: boolean;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (rationale: string) => void;
}) {
  const [rationale, setRationale] = useState("");
  return <ActionDialog
    open={open}
    onClose={onClose}
    title="ルールを廃止"
    error={error}
    actions={<DialogActions
      onCancel={onClose}
      onConfirm={() => onSubmit(rationale)}
      confirmLabel="廃止"
      confirmVariant="danger"
      loading={loading}
      confirmDisabled={!rationale.trim()}
    />}
  >
    <p>廃止する理由を記録してください。</p>
    <TextArea label="理由" required value={rationale} onChange={(event) => setRationale(event.target.value)}/>
  </ActionDialog>;
}
