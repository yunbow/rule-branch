import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { RuleCreateForm } from "../../../../../components/domain/RuleCreateForm.tsx";
import { Breadcrumbs, PageHeader, PageSection } from "../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../server/session.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../../../../shared/permissions.ts";
import { loginPathForContinuation } from "../../../../../shared/auth-navigation.ts";

export default async function NewOrganizationRulePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await getSessionUser();
  if (!user) redirect(loginPathForContinuation((await headers()).get("x-rulebranch-request-target")));

  const { workspace, membership } = await getWorkspaceAccess(workspaceId, String(user.id));
  if (!workspace || !membership) notFound();
  if (workspace.kind === "personal") redirect(`/w/${workspaceId}`);

  return <main className="pageContainer pageContainerNarrow">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/rules`}>組織ルール</Link>
      <span className="separator">/</span>
      <span>新規作成</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="組織ルール"
      title="組織ルールを作成"
      description="Workspace全体で共有する方針・基準・ガイドラインを定義します。"
    />
    <PageSection>
      <RuleCreateForm
        workspaceId={workspaceId}
        writable={canWrite(workspace.kind as WorkspaceKind, membership.role as WorkspaceRole)}
      />
    </PageSection>
  </main>;
}
