"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import { ActionDialog } from "../ui/index.tsx";
import { RuleMetaEditForm, type RuleMetaEditHandle } from "./RuleMetaEditForm.tsx";

export function RuleMetaEditDialog({ open, onClose, workspaceId, rule, repositories, writable }: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  rule: Record<string, unknown>;
  repositories: { id: string; fullName: string; status?: string }[];
  writable: boolean;
}) {
  const router = useRouter();
  const formRef = useRef<RuleMetaEditHandle>(null);
  return <ActionDialog
    open={open}
    onClose={() => formRef.current?.cancel()}
    title="ルール情報を編集"
    titleId="rule-meta-edit-title"
    size="wide"
  >
    {open && (
      <RuleMetaEditForm
        workspaceId={workspaceId}
        rule={rule}
        repositories={repositories}
        cancelRef={formRef}
        writable={writable}
        onCancel={onClose}
        onSaved={() => { onClose(); router.refresh(); }}
      />
    )}
  </ActionDialog>;
}
