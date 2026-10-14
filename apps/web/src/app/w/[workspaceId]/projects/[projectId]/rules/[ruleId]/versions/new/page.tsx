import Link from "next/link";
import { notFound } from "next/navigation";
import { VersionCreateForm } from "../../../../../../../../../components/domain/VersionCreateForm.tsx";
import { ProjectNav } from "../../../../../../../../../components/layout/ProjectNav.tsx";
import { StatusBadge } from "../../../../../../../../../components/ui/index.tsx";
import { Breadcrumbs, PageHeader } from "../../../../../../../../../components/ui/Page.tsx";
import { getWorkspaceAccess } from "../../../../../../../../../server/queries.ts";
import { getSessionUser } from "../../../../../../../../../server/session.ts";
import { getRuntime } from "../../../../../../../../../shared/runtime.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../../../../../../../../shared/permissions.ts";

export default async function NewVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string; ruleId: string }>;
  searchParams: Promise<{ supersedes?: string; from?: string }>;
}) {
  const p = await params;
  const { supersedes, from } = await searchParams;
  const sourceId = supersedes ?? from;
  const user = await getSessionUser();
  const runtime = getRuntime();
  if (!user || !runtime.store || !runtime.rules || !runtime.projectRepositories) notFound();

  const uid = String(user.id);
  const [{ workspace, membership }, project, rule, versions, repositories] = await Promise.all([
    getWorkspaceAccess(p.workspaceId, uid),
    runtime.projectRepositories.getProject(p.workspaceId, uid, p.projectId),
    runtime.rules.getRule(p.workspaceId, uid, p.ruleId),
    runtime.rules.listRuleVersions(p.workspaceId, uid, p.ruleId) as Promise<Record<string, unknown>[]>,
    runtime.projectRepositories.listRepositories(p.workspaceId, uid, p.projectId),
  ]);
  if (!workspace || !membership || rule.projectId !== p.projectId) notFound();

  const previous = sourceId
    ? versions.find((version) => version.id === sourceId)
    : undefined;
  if (sourceId && !previous) notFound();

  const currentVersionId = typeof rule.currentVersionId === "string" ? rule.currentVersionId : null;
  const current = versions.find((version) => version.id === currentVersionId);
  const sourceProvenance = previous?.provenance as Record<string, unknown> | undefined;
  const sourceType = typeof sourceProvenance?.sourceType === "string" ? sourceProvenance.sourceType : "human";
  const sourceVersion = previous
    ? {
        id: String(previous.id),
        number: String(previous.version),
        status: String(previous.status),
        sourceType,
        content: String(previous.content ?? ""),
        rationale: String(previous.rationale ?? ""),
      }
    : null;
  const initial = {
    content: String(previous?.content ?? ""),
    // A correction requires a new explanation; keep the original reason as reference.
    rationale: "",
    evidenceIds: Array.isArray(previous?.evidenceIds)
      ? previous.evidenceIds.filter((item): item is string => typeof item === "string")
      : [],
    compatibility: previous?.compatibility ?? {},
    changeType: String(previous?.changeType ?? "initial"),
  };

  return <main className="pageContainer">
    <Breadcrumbs>
      <Link href={"/w/" + p.workspaceId}>{String(workspace.name)}</Link>
      <span className="separator">/</span>
      <Link href={"/w/" + p.workspaceId + "/projects/" + p.projectId}>{String(project.name)}</Link>
      <span className="separator">/</span>
      <Link href={"/w/" + p.workspaceId + "/projects/" + p.projectId + "/rules/" + p.ruleId}>{String(rule.title)}</Link>
      <span className="separator">/</span>
      <span>{sourceVersion ? "修正版を作成" : "新しいVersionを作成"}</span>
    </Breadcrumbs>
    <PageHeader
      eyebrow={sourceVersion ? "Version修正" : "Version作成"}
      title={String(rule.title)}
      description={sourceVersion
        ? "元バージョン v" + sourceVersion.number + " を参考に、変更内容を確認して修正版を作成します。"
        : "ルール本文と変更理由を入力し、レビュー対象の新しいバージョンを提案します。"}
      meta={sourceVersion && <>
        <span className="versionHeaderMetaGroup">
          <span>元バージョン</span>
          <StatusBadge kind="rule_versions.status" value={sourceVersion.status}/>
        </span>
        <span className="versionHeaderMetaGroup">
          <span>作成元</span>
          <StatusBadge kind="provenance" value={sourceVersion.sourceType}/>
        </span>
      </>}
    />
    <ProjectNav workspaceId={p.workspaceId} projectId={p.projectId}/>
    <VersionCreateForm
      key={(supersedes ? "replace:" : "copy:") + (sourceId ?? "new")}
      replaceSource={Boolean(supersedes)}
      workspaceId={p.workspaceId}
      projectId={p.projectId}
      ruleId={p.ruleId}
      initial={initial}
      sourceVersion={sourceVersion}
      currentVersion={current && currentVersionId
        ? { id: currentVersionId, number: String(current.version), content: String(current.content ?? "") }
        : null}
      repositories={repositories.map((item) => ({ id: String(item.id), fullName: String(item.fullName) }))}
      writable={canWrite(workspace.kind as WorkspaceKind, membership.role as WorkspaceRole)}
    />
  </main>;
}
