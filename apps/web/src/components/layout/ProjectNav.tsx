"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { suffix: "", label: "概要" },
  { suffix: "/rules", label: "ルール" },
  { suffix: "/drift", label: "ずれの検知" },
  { suffix: "/publications", label: "反映状況" },
  { suffix: "/decisions", label: "判断記録" },
] as const;

export function ProjectNav({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const pathname = usePathname();
  const root = `/w/${workspaceId}/projects/${projectId}`;

  return <nav className="projectNav" aria-label="プロジェクトナビゲーション">
    {ITEMS.map((item) => {
      const href = `${root}${item.suffix}`;
      const active = item.suffix === ""
        ? pathname === root
        : pathname === href || pathname.startsWith(`${href}/`);
      return <Link className={active ? "active" : ""} aria-current={active ? "page" : undefined} href={href} key={item.suffix || "overview"}>
        {item.label}
      </Link>;
    })}
  </nav>;
}
