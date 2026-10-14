import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleListClient, type RuleTab } from "../../../../../../components/domain/RuleListClient.tsx";
import type { RuleFilters } from "../../../../../../lib/rule-list.ts";
import type { PublicationState } from "../../../../../../components/domain/PublicationBadge.tsx";
import { ProjectNav } from "../../../../../../components/layout/ProjectNav.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../shared/runtime.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../../../../../shared/permissions.ts";

export default async function RulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ tab?: string; q?: string; layer?: string; enforcement?: string; type?: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const { tab, q, layer, enforcement, type } = await searchParams;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.rules || !runtime.projectRepositories) notFound();

  const userId = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, userId);
  if (!workspace || !membership) notFound();

  const [project, rules] = await Promise.all([
    runtime.projectRepositories.getProject(workspaceId, userId, projectId),
    runtime.rules.listProjectRules(workspaceId, userId, projectId) as unknown as Record<string, unknown>[],
  ]);
  const currentVersionIds = rules.map((rule) => rule.currentVersionId).filter((id): id is string => typeof id === "string");
  const publicationStates = await runtime.rules.getPublicationStates(workspaceId, userId, currentVersionIds) as Record<string, PublicationState>;
  const initialTab: RuleTab = ["all", "draft", "stale", "active", "other"].includes(tab ?? "") ? tab as RuleTab : "all";
  const initialFilters: RuleFilters = {
    query: typeof q === "string" ? q.slice(0, 160) : "",
    layer: ["L1", "L2", "L3"].includes(layer ?? "") ? layer! : "",
    enforcement: ["locked", "default", "advisory", "personal"].includes(enforcement ?? "") ? enforcement! : "",
    type: ["policy", "guideline", "workflow", "architecture", "security", "coding-style", "interaction"].includes(type ?? "") ? type! : "",
  };

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={`/w/${workspaceId}/projects/${projectId}`}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <span>ルール</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="プロジェクトルール"
      title="プロジェクトルール"
      description="このプロジェクトに適用するルールを、状態・レイヤー・適用レベルから確認します。"
    />
    <ProjectNav workspaceId={workspaceId} projectId={projectId}/>
    <RuleListClient
      rules={rules.map((rule) => ({
        id: String(rule.id),
        title: String(rule.title),
        key: String(rule.key),
        layer: String(rule.layer),
        enforcement: String(rule.enforcement),
        status: String(rule.status),
        type: String(rule.type),
        scopeType: String(rule.scopeType),
        sourceType: typeof (rule.provenance as Record<string, unknown> | undefined)?.sourceType === "string"
          ? (rule.provenance as Record<string, unknown>).sourceType as string : undefined,
        currentVersionId: typeof rule.currentVersionId === "string" ? rule.currentVersionId : null,
        updatedAt: typeof rule.updatedAt === "string" ? rule.updatedAt : null,
        possiblePromptInjection: rule.possiblePromptInjection === true,
        publicationState: typeof rule.currentVersionId === "string" ? publicationStates[rule.currentVersionId] : undefined,
      }))}
      workspaceId={workspaceId}
      projectId={projectId}
      workspaceKind={workspace.kind as WorkspaceKind}
      role={membership.role as WorkspaceRole}
      initialTab={initialTab}
      initialFilters={initialFilters}
    />
  </main>;
}
