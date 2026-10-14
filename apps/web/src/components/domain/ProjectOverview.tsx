"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/index.tsx";
import { RepositoryAddDialog } from "./RepositoryAddDialog.tsx";
import { RepositoryTable, type RepositoryRow } from "./RepositoryTable.tsx";
import type { InstallationOption } from "./InstallationSelect.tsx";

export function ProjectOverview({
  workspaceId,
  projectId,
  repositories,
  installations,
  canManage,
}: {
  workspaceId: string;
  projectId: string;
  repositories: RepositoryRow[];
  installations: InstallationOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const hasActiveRepository = repositories.some((repository) => repository.status === "active");

  return <section className="pageSection pageSectionCard projectRepositorySection">
    <header className="pageSectionHeader">
      <div>
        <h2>リポジトリ <span className="projectSectionCount">{repositories.length}件</span></h2>
        <p>解析とルール更新の対象になるGitHubリポジトリです。</p>
      </div>
      {canManage && <Button type="button" variant={hasActiveRepository ? "secondary" : "primary"}
        onClick={() => setAdding(true)}>リポジトリを追加</Button>}
    </header>

    <RepositoryTable
      workspaceId={workspaceId}
      repositories={repositories}
      canManage={canManage}
      onChanged={() => router.refresh()}
    />

    {adding && <RepositoryAddDialog
      workspaceId={workspaceId}
      projectId={projectId}
      installations={installations}
      onClose={() => setAdding(false)}
      onAdded={() => router.refresh()}
    />}
  </section>;
}
