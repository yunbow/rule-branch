"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ScrollText, FolderKanban, Inbox, LayoutDashboard, Network, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api-client.ts";
import { EMPTY_SHELL_ME, loadShellMe, type ShellMe } from "../../lib/shell-me.ts";
import { hasRole, type WorkspaceRole } from "../../shared/permissions.ts";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
import { UserMenu } from "./UserMenu.tsx";

export { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";
export { UserMenu } from "./UserMenu.tsx";

const ROLE_LABELS: Record<string, string> = { owner: "オーナー", admin: "管理者", maintainer: "メンテナー", member: "メンバー", viewer: "閲覧者" };

function NavItem({ href, label, active, icon, badge }: { href: string; label: string; active: boolean; icon: React.ReactNode; badge?: number }) {
  return <Link className={`appNavLink${active ? " active" : ""}`} href={href}>
    <span className="appNavIcon" aria-hidden="true">{icon}</span>
    <span>{label}</span>
    {typeof badge === "number" && badge > 0 && <span className="appNavBadge" aria-label={`${badge}件`}>{badge}</span>}
  </Link>;
}

export const Sidebar = ({ role, workspaceId, workspaceKind, reviewCount = 0 }: {
  role: string;
  workspaceId: string;
  workspaceKind: "personal" | "organization";
  reviewCount?: number;
}) => {
  const pathname = usePathname();
  const root = `/w/${workspaceId}`;
  const projectsRoot = `${root}/projects`;
  const projectActive = pathname === projectsRoot || pathname.startsWith(`${projectsRoot}/`);

  return <aside className="appSidebar">
    <nav className="appNav" aria-label="Workspace navigation">
      <span className="appNavSectionLabel">ワークスペース</span>
      <NavItem href={root} label="概要" active={pathname === root} icon={<LayoutDashboard size={17}/>} />
      <NavItem href={projectsRoot} label="プロジェクト" active={projectActive} icon={<FolderKanban size={17}/>} />
      <NavItem href={`${root}/reviews`} label="承認待ち" active={pathname.startsWith(`${root}/reviews`)} icon={<Inbox size={17}/>} badge={reviewCount} />
      {workspaceKind === "organization" && <>
        <span className="appNavSectionLabel">ルール</span>
        <NavItem href={`${root}/rules`} label="組織ルール" active={pathname.startsWith(`${root}/rules`)} icon={<ShieldCheck size={17}/>} />
        <NavItem href={`${root}/relations`} label="ルールの関係" active={pathname.startsWith(`${root}/relations`)} icon={<Network size={17}/>} />
      </>}
      <span className="appNavSectionLabel">管理</span>
      <NavItem href={`${root}/members`} label="メンバー" active={pathname.startsWith(`${root}/members`)} icon={<Users size={17}/>} />
      {hasRole(role as WorkspaceRole, "admin") && <NavItem href={`${root}/audit-logs`} label="監査ログ" active={pathname.startsWith(`${root}/audit-logs`)} icon={<ScrollText size={17}/>} />}
    </nav>
    <div className="appSidebarMeta">
      <span>現在の権限</span>
      <strong>{ROLE_LABELS[role] ?? role}</strong>
    </div>
  </aside>;
};

export function AppShell({ children, workspaceId, role, name, workspaceKind, reviewCount = 0 }: {
  children: React.ReactNode;
  workspaceId: string;
  role: string;
  name: string;
  workspaceKind: "personal" | "organization";
  reviewCount?: number;
}) {
  const [me, setMe] = useState<ShellMe>(EMPTY_SHELL_ME);
  useEffect(() => {
    void loadShellMe(() => apiFetch<ShellMe>("/api/me")).then(setMe);
  }, []);
  return <>
    <header className="appHeader">
      <Link className="appBrand" href={`/w/${workspaceId}`} aria-label="RuleBranch">
        <img className="appBrandMark" src="/brand/icon-192.png" alt="" width="32" height="32" />
        <strong>RuleBranch</strong>
      </Link>
      <div className="appHeaderWorkspace"><WorkspaceSwitcher workspaceId={workspaceId} workspaces={me.workspaces}/></div>
      <div className="appHeaderUser"><UserMenu name={name} pending={me.pendingInvitations}/></div>
    </header>
    <div className="shell">
      <Sidebar workspaceId={workspaceId} role={role} workspaceKind={workspaceKind} reviewCount={reviewCount}/>
      <div className="appContent">{children}</div>
    </div>
  </>;
}
