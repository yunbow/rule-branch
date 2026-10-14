import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { RelationForm } from "../../../../components/domain/RelationForm.tsx";
import { RelationTable } from "../../../../components/domain/RelationTable.tsx";
import { Breadcrumbs, PageHeader, PageSection } from "../../../../components/ui/Page.tsx";
import { getProjects, getRuleRelations, getRules, getWorkspaceAccess } from "../../../../server/queries.ts";
import { getSessionUser } from "../../../../server/session.ts";
import { getRuntime } from "../../../../shared/runtime.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../../../shared/permissions.ts";

export default async function RelationsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await getSessionUser();
  const store = getRuntime().store;
  if (!user || !store) notFound();

  const userId = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, userId);
  if (!workspace || !membership) notFound();
  if (workspace.kind === "personal") redirect(`/w/${workspaceId}`);

  const [rawRules, rawRelations, projects] = await Promise.all([
    getRules(workspaceId, userId),
    getRuleRelations(workspaceId, userId),
    getProjects(workspaceId, userId),
  ]);
  const rules = rawRules as Record<string, unknown>[];
  const projectNames = Object.fromEntries((projects as Record<string, unknown>[]).map(
    (project) => [String(project.id), String(project.name)],
  ));
  const formRules = rules.map((rule) => ({
    id: String(rule.id),
    title: String(rule.title),
    scopeType: String(rule.scopeType),
    status: String(rule.status),
    projectId: typeof rule.projectId === "string" ? rule.projectId : null,
    projectName: typeof rule.projectId === "string" ? projectNames[rule.projectId] : undefined,
  }));
  const ruleTitles = Object.fromEntries(rules.map((rule) => [String(rule.id), String(rule.title)]));
  const relations = (rawRelations as Record<string, unknown>[]).map((relation) => ({
    id: String(relation.id),
    childRuleId: String(relation.childRuleId),
    parentRuleId: String(relation.parentRuleId),
    relationType: String(relation.relationType),
    rationale: typeof relation.rationale === "string" ? relation.rationale : null,
    validationStatus: String(relation.validationStatus),
    createdAt: typeof relation.createdAt === "string" ? relation.createdAt : null,
  }));

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <span>ルールの関係</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="ルールの関係"
      title="ルールの関係"
      description="組織ルールとプロジェクトルールの継承・上書き・不適用関係を管理します。"
      actions={<RelationForm
        workspaceId={workspaceId}
        rules={formRules}
        workspaceKind={workspace.kind as WorkspaceKind}
        role={membership.role as WorkspaceRole}
      />}
    />
    <PageSection title="関係一覧" description="子ルールから見た親ルールとの関係と検証状態を表示します。">
      <RelationTable relations={relations} ruleTitles={ruleTitles}/>
      <p className="formNote">関係の削除は現在サポートされていません。</p>
    </PageSection>
  </main>;
}
