import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSessionUser } from "../../../server/session.ts";
import { getWorkspaceAccess } from "../../../server/queries.ts";
import { getRuntime } from "../../../shared/runtime.ts";
import { AppShell } from "../../../components/layout/index.tsx";
import { loginPathForContinuation } from "../../../shared/auth-navigation.ts";

export default async function WorkspaceLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect(loginPathForContinuation((await headers()).get("x-rulebranch-request-target")));

  const { workspaceId } = await params;
  const userId = String(user.id);
  const { workspace, membership: member } = await getWorkspaceAccess(workspaceId, userId);
  if (!member || !workspace) {
    return <main><h1>この操作の権限がありません(必要ロール: viewer 以上)</h1><p>このWorkspaceのメンバーではありません</p></main>;
  }

  const runtime = getRuntime();
  const reviewCount = runtime.rules ? (await runtime.rules.listReviewQueue(workspaceId, userId)).length : 0;
  const kind = workspace.kind === "personal" ? "personal" : "organization";

  return <AppShell
    workspaceId={workspaceId}
    role={String(member.role)}
    name={String(user.displayName)}
    workspaceKind={kind}
    reviewCount={reviewCount}
  >{children}</AppShell>;
}
