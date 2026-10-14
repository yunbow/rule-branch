import { getVersionSource } from "../../../../../../../lib/rule-version-detail.ts";
import "../../../../projects/[projectId]/rules/[ruleId]/versions/[versionId]/version-detail.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VersionDetailClient } from "../../../../../../../components/domain/VersionDetailClient.tsx";
import { PublicationBadge } from "../../../../../../../components/domain/PublicationBadge.tsx";
import { StatusBadge } from "../../../../../../../components/ui/index.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../../shared/runtime.ts";
import {
  canApproveRuleVersion,
  canWrite,
  type RuleEnforcement,
  type RuleScopeType,
  type WorkspaceKind,
  type WorkspaceRole,
} from "../../../../../../../shared/permissions.ts";

export default async function VersionPage({
  params,
}: {
  params: Promise<{ workspaceId: string; ruleId: string; versionId: string }>;
}) {
  const p = await params;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.rules || !runtime.store) notFound();

  const uid = String(user.id);
  const [rule, versions, { workspace, membership }] = await Promise.all([

    runtime.rules.getRule(p.workspaceId, uid, p.ruleId),
    runtime.rules.listRuleVersions(p.workspaceId, uid, p.ruleId) as Promise<Record<string, unknown>[]>,

    getWorkspaceAccess(p.workspaceId, uid),
  ]);
  const version = versions.find((item) => item.id === p.versionId);
  if (!version || !workspace || !membership || rule.scopeType !== "organization" || rule.scopeId !== p.workspaceId) notFound();

  const currentVersionId = typeof rule.currentVersionId === "string" ? rule.currentVersionId : null;
  const current = versions.find((item) => item.id === currentVersionId);
  const superseded = getVersionSource(version, versions);
  const kind = workspace.kind as WorkspaceKind;
  const role = membership.role as WorkspaceRole;
  const repositoryViews: { id: string; fullName: string }[] = [];

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={`/w/${p.workspaceId}`}>{String(workspace.name)}</Link>
      <span className="separator">/</span>

      <Link href={`/w/${p.workspaceId}/rules/${p.ruleId}`}>{String(rule.title)}</Link>
      <span className="separator">/</span>
      <span>v{String(version.version)}</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow={`ルールVersion v${String(version.version)}`}
      title={String(rule.title)}
      description="変更概要、本文、根拠コード、評価結果と承認履歴を確認します。"
      meta={<>
        <span className="versionHeaderMetaGroup"><span>承認状態</span><StatusBadge kind="rule_versions.status" value={String(version.status)}/></span>
        <span className="versionHeaderMetaGroup"><span>GitHub反映</span><PublicationBadge versionId={String(version.id)} workspaceId={p.workspaceId} repositories={repositoryViews}/></span>
      </>}
    />

    <VersionDetailClient
      workspaceId={p.workspaceId}
      version={version}
      repositories={repositoryViews}
      currentVersionId={currentVersionId}
      currentVersionNumber={current?.version == null ? null : String(current.version)}
      currentContent={typeof current?.content === "string" ? current.content : undefined}
      sourceVersionId={typeof superseded?.id === "string" ? superseded.id : null}
      supersededVersionNumber={superseded?.version == null ? null : String(superseded.version)}
      canApprove={canApproveRuleVersion({
        workspaceKind: kind,
        enforcement: rule.enforcement as RuleEnforcement,
        scopeType: rule.scopeType as RuleScopeType,
      }, role)}
      canWrite={canWrite(kind, role)}
      canWithdraw={(version.createdBy as { kind?: string; id?: string } | undefined)?.kind === "user"
        && (version.createdBy as { id?: string }).id === uid}
    />
  </main>;
}
