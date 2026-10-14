import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleMetaEditForm } from "../../../../../../components/domain/RuleMetaEditForm.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../components/ui/Page.tsx";
import { StatusBadge } from "../../../../../../components/ui/index.tsx";
import { getWorkspaceAccess } from "../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../shared/runtime.ts";
import { isRuleStoreError } from "../../../../../../shared/rulestore.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../../../../../shared/permissions.ts";

export default async function EditOrganizationRulePage({ params }: {
  params: Promise<{ workspaceId: string; ruleId: string }>;
}) {
  const { workspaceId, ruleId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.rules) notFound();
  const uid = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, uid);
  if (!workspace || !membership) notFound();

  const rule = await runtime.rules.getRule(workspaceId, uid, ruleId).catch((error: unknown) => {
    if (isRuleStoreError(error) && ["NOT_FOUND", "FORBIDDEN"].includes(error.code)) notFound();
    throw error;
  });
  if (rule.scopeType !== "organization" || rule.scopeId !== workspaceId) notFound();
  const base = `/w/${workspaceId}/rules/${ruleId}`;

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>

      <Link href={base}>{String(rule.title)}</Link>
      <span className="separator">/</span>
      <span>ルール設定を編集</span>
    </Breadcrumbs>
    <PageHeader eyebrow="ルール設定を編集" title={String(rule.title)}
      description="基本情報・適用条件・変更監視の設定を更新します。"
      meta={<>
        <span className="ruleMetaHeaderFact"><span>状態</span><StatusBadge kind="rules.status" value={String(rule.status)}/></span>
        <span className="ruleMetaHeaderFact"><span>適用範囲</span><strong>組織全体</strong></span>
      </>}/>

    <RuleMetaEditForm key={`${rule.id}:${rule.updatedAt}`} workspaceId={workspaceId} rule={rule}
        repositories={[]}
        writable={canWrite(workspace.kind as WorkspaceKind, membership.role as WorkspaceRole)} backHref={base}/>
  </main>;
}
