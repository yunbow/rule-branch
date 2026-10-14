import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../server/queries.ts";
import { getSessionUser } from "../../../../server/session.ts";
import { getRuntime } from "../../../../shared/runtime.ts";
import { hasRole, type WorkspaceRole } from "../../../../shared/permissions.ts";
import { listAuditLogs } from "../../../../shared/audit-logs.ts";
import { AuditLogList } from "./AuditLogList.tsx";

export default async function AuditLogsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store) notFound();
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, String(user.id));
  if (!workspace || !membership || !hasRole(membership.role as WorkspaceRole, "admin")) notFound();
  const initial = await listAuditLogs(runtime.store, workspaceId, String(user.id));
  return <main className="pageContainer">
    <Breadcrumbs><Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link><span className="separator">/</span><span>監査ログ</span></Breadcrumbs>
    <PageHeader eyebrow="Workspace管理" title="監査ログ" description="ルールやメンバーなどの変更を、実行者と日時から確認できます。管理者以上が閲覧できます。"/>
    <AuditLogList workspaceId={workspaceId} initial={initial}/>
  </main>;
}
