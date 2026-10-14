"use client";

import { useState } from "react";
import { ActionDialog, DialogActions, TextArea } from "../ui/index.tsx";

export function ApproveDialog({
  open, loading, onClose, onApprove,
}: {
  open: boolean;
  loading: boolean;
  onClose: () => void;
  onApprove: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  return <ActionDialog
    open={open}
    onClose={onClose}
    title="候補を承認"
    actions={<DialogActions
      onCancel={onClose}
      onConfirm={() => onApprove(comment)}
      confirmLabel="承認"
      loading={loading}
    />}
  >
    <TextArea label="コメント（任意）" value={comment} onChange={(event) => setComment(event.target.value)}/>
  </ActionDialog>;
}
