import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { RuleListClient } from "../../../../components/domain/RuleListClient.tsx";
import type { PublicationState } from "../../../../components/domain/PublicationBadge.tsx";
import { Breadcrumbs, PageHeader } from "../../../../components/ui/Page.tsx";
import { getRules, getWorkspaceAccess } from "../../../../server/queries.ts";
import { getSessionUser } from "../../../../server/session.ts";
import { getRuntime } from "../../../../shared/runtime.ts";
import type { WorkspaceKind, WorkspaceRole } from "../../../../shared/permissions.ts";

export default async function OrganizationRulesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  const store = runtime.store;
  if (!user || !store || !runtime.rules) notFound();

  const userId = String(user.id);
  const { workspace, membership } = await getWorkspaceAccess(workspaceId, userId);
  if (!workspace || !membership) notFound();
  if (workspace.kind === "personal") redirect(`/w/${workspaceId}`);

  const rules = await getRules(workspaceId, userId) as Record<string, unknown>[];
  const currentVersionIds = rules
    .map((rule) => rule.currentVersionId)
    .filter((id): id is string => typeof id === "string");
  const publicationStates = await runtime.rules.getPublicationStates(
    workspaceId,
    userId,
    currentVersionIds,
  ) as Record<string, PublicationState>;

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <span>組織ルール</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow="組織ルール"
      title="組織ルール"
      description="Workspace全体で共有するルールを、状態・レイヤー・適用レベルから確認できます。"
    />
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
          ? (rule.provenance as Record<string, unknown>).sourceType as string
          : undefined,
        currentVersionId: typeof rule.currentVersionId === "string" ? rule.currentVersionId : null,
        updatedAt: typeof rule.updatedAt === "string" ? rule.updatedAt : null,
        possiblePromptInjection: rule.possiblePromptInjection === true,
        publicationState: typeof rule.currentVersionId === "string" ? publicationStates[rule.currentVersionId] : undefined,
      }))}
      workspaceId={workspaceId}
      workspaceKind={workspace.kind as WorkspaceKind}
      role={membership.role as WorkspaceRole}
      scopeType="organization"
    />
  </main>;
}
