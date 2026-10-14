"use client";

import { useState } from "react";
import { ActionDialog, DialogActions, Select } from "../ui/index.tsx";

export function RestoreDialog({
  open, loading, error, versions, onClose, onSubmit,
}: {
  open: boolean;
  loading: boolean;
  error?: string | null;
  versions: { id: string; version: string }[];
  onClose: () => void;
  onSubmit: (id: string) => void;
}) {
  const [id, setId] = useState("");
  return <ActionDialog
    open={open}
    onClose={onClose}
    title="ルールを復活"
    error={error}
    actions={<DialogActions
      onCancel={onClose}
      onConfirm={() => onSubmit(id)}
      confirmLabel="復活"
      loading={loading}
      confirmDisabled={!id}
    />}
  >
    <p>復活時に承認するバージョンを選択してください。</p>
    <Select label="承認する proposed version" value={id} onChange={(event) => setId(event.target.value)}>
      <option value="">選択してください</option>
      {versions.map((version) => <option key={version.id} value={version.id}>v{version.version}</option>)}
    </Select>
  </ActionDialog>;
}
