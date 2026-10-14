"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import {
  canRestoreArchivedRule,
  hasWorkspacePermission,
  type WorkspaceKind,
  type WorkspaceRole,
} from "../../shared/permissions.ts";
import { Button } from "../ui/index.tsx";
import { DeprecateDialog } from "./DeprecateDialog.tsx";
import { SupersedeDialog } from "./SupersedeDialog.tsx";
import { ArchiveDialog } from "./ArchiveDialog.tsx";
import { RestoreDialog } from "./RestoreDialog.tsx";

export function LifecycleActionMenu({
  rule,
  allRules,
  versions,
  workspaceId,
  basePath,
  kind,
  role,
}: {
  rule: Record<string, unknown>;
  allRules: Record<string, unknown>[];
  versions: Record<string, unknown>[];
  workspaceId: string;
  basePath: string;
  kind: WorkspaceKind;
  role: WorkspaceRole;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = hasWorkspacePermission(kind, role, "member");
  const status = String(rule.status);

  const go = async (body: Record<string, unknown>) => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/api/rules/${rule.id}/status`, { method: "POST", workspaceId, body });
      location.reload();
    } catch (reason) {
      const code = reason instanceof ApiError ? reason.code : "INTERNAL_ERROR";
      setError(code);
      if (code === "SUPERSEDED_BY_RULE_INVALID") router.refresh();
      setLoading(false);
    }
  };

  const openDialog = (next: string) => {
    if (loading) return;
    setError(null);
    setDialog(next);
  };
  const closeDialog = () => {
    if (loading) return;
    setDialog("");
    setError(null);
  };

  const target = allRules
    .filter((item) => item.id !== rule.id && ["active", "stale"].includes(String(item.status)))
    .map((item) => ({ id: String(item.id), title: String(item.title) }));
  const proposed = versions
    .filter((item) => item.status === "proposed")
    .map((item) => ({ id: String(item.id), version: String(item.version) }));

  return <>
    <div className="actionBar">
      {writable && <>
        <Link className="button secondary" href={`${basePath}/edit`}>メタ情報を編集</Link>
        <Link className="button primary" href={`${basePath}/versions/new`}>新しいVersion</Link>
        {["active", "stale"].includes(status) && <>
          <Button type="button" variant="secondary" onClick={() => openDialog("supersede")}>別ルールへ統合</Button>
          <Button type="button" variant="danger" onClick={() => openDialog("deprecate")}>廃止</Button>
        </>}
        {["draft", "deprecated", "superseded"].includes(status) &&
          <Button type="button" variant="danger" onClick={() => openDialog("archive")}>アーカイブ</Button>}
      </>}
      {status === "archived" && canRestoreArchivedRule(kind, role) &&
        <Button type="button" onClick={() => openDialog("restore")}>復活</Button>}
    </div>
    <DeprecateDialog
      open={dialog === "deprecate"}
      loading={loading}
      error={error}
      onClose={closeDialog}
      onSubmit={(rationale) => go({ status: "deprecated", rationale })}
    />
    <SupersedeDialog
      open={dialog === "supersede"}
      loading={loading}
      error={error}
      rules={target}
      onClose={closeDialog}
      onSubmit={(supersededByRuleId, rationale) => go({ status: "superseded", supersededByRuleId, rationale })}
    />
    <ArchiveDialog
      open={dialog === "archive"}
      loading={loading}
      error={error}
      onClose={closeDialog}
      onSubmit={() => go({ status: "archived" })}
    />
    <RestoreDialog
      open={dialog === "restore"}
      loading={loading}
      error={error}
      versions={proposed}
      onClose={closeDialog}
      onSubmit={(approvedVersionId) => go({ status: "active", approvedVersionId })}
    />
  </>;
}
