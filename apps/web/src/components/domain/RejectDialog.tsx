"use client";

import { useState } from "react";
import { ActionDialog, DialogActions, TextArea } from "../ui/index.tsx";

export function RejectDialog({
  open, loading, onClose, onReject,
}: {
  open: boolean;
  loading: boolean;
  onClose: () => void;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const valid = Boolean(reason.trim());

  return <ActionDialog
    open={open}
    onClose={onClose}
    title="この版のみ却下"
    actions={<DialogActions
      onCancel={onClose}
      onConfirm={() => onReject(reason)}
      confirmLabel="却下"
      confirmVariant="danger"
      loading={loading}
      confirmDisabled={!valid}
    />}
  >
    <TextArea label="却下理由" aria-required="true" required value={reason}
      onChange={(event) => setReason(event.target.value)}/>
  </ActionDialog>;
}
