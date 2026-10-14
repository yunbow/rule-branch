"use client";

import { ActionDialog, DialogActions } from "../ui/index.tsx";

export function ArchiveDialog({
  open, loading, error, onClose, onSubmit,
}: {
  open: boolean;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return <ActionDialog
    open={open}
    onClose={onClose}
    title="ルールをアーカイブ"
    error={error}
    actions={<DialogActions
      onCancel={onClose}
      onConfirm={onSubmit}
      confirmLabel="アーカイブ"
      confirmVariant="danger"
      loading={loading}
    />}
  >
    <p>このルールをアーカイブしますか？</p>
  </ActionDialog>;
}
