export type ProjectStatusCounts = {
  candidates: number;
  stale: number;
  unpublished: number;
  published: number;
};

export type ProjectAction = {
  id: "repositories" | "awaiting-analysis" | "failed" | "candidates" | "stale" | "unpublished" | "running" | "rules";
  href: string;
  label: string;
  description: string;
  shortLabel: string;
};

export type ProjectOverviewActionInput = {
  basePath: string;
  repositoryCount: number;
  activeRepositoryCount: number;
  canManageRepositories: boolean;
  activeJobCount: number;
  jobCount: number;
  latestJobFailed: boolean;
  counts: ProjectStatusCounts;
};

/**
 * One clear primary action with at most one additional outstanding task.
 * A running job remains visible separately and does not hide review work.
 */
export function getProjectNextActions(input: ProjectOverviewActionInput): {
  primary: ProjectAction;
  secondary?: ProjectAction;
} {
  const { basePath, repositoryCount, activeRepositoryCount, canManageRepositories, activeJobCount, jobCount, latestJobFailed, counts } = input;

  if (activeRepositoryCount === 0) {
    return {
      primary: repositoryCount === 0
        ? {
            id: "repositories",
            href: "#repositories",
            label: canManageRepositories ? "リポジトリを追加" : "接続状況を確認",
            shortLabel: canManageRepositories ? "リポジトリを追加" : "接続状況を確認",
            description: canManageRepositories
              ? "解析を始めるには、対象となるGitHubリポジトリを追加してください。"
              : "対象リポジトリがまだありません。Workspace管理者に追加を依頼してください。",
          }
        : {
            id: "repositories",
            href: "#repositories",
            label: "リポジトリを確認",
            shortLabel: "リポジトリを確認",
            description: canManageRepositories
              ? "利用可能なリポジトリがありません。連携状況を確認してください。"
              : "利用可能なリポジトリがありません。Workspace管理者に連携状況の確認を依頼してください。",
          },
    };
  }

  const pending: ProjectAction[] = [];
  if (latestJobFailed) pending.push({
    id: "failed", href: "#jobs", label: "失敗内容を確認", shortLabel: "直近の処理が失敗",
    description: "直近の解析処理に失敗しました。エラー内容を確認してください。",
  });
  if (counts.candidates > 0) pending.push({
    id: "candidates", href: basePath + "/rules?tab=draft",
    label: "候補を確認", shortLabel: "候補ルール " + counts.candidates + "件",
    description: "確認できる候補ルールが" + counts.candidates + "件あります。本文と根拠を確認してください。",
  });
  if (counts.stale > 0) pending.push({
    id: "stale", href: basePath + "/drift",
    label: "ずれの指摘を確認", shortLabel: "要確認ルール " + counts.stale + "件",
    description: "要確認ルールが" + counts.stale + "件あります。コードとのずれを確認してください。",
  });
  if (counts.unpublished > 0) pending.push({
    id: "unpublished", href: basePath + "/publications",
    label: "反映状況を確認", shortLabel: "承認済み・未反映 " + counts.unpublished + "件",
    description: "承認済みルール" + counts.unpublished + "件の反映が完了していません。GitHubへの反映状況を確認してください。",
  });
  if (activeJobCount > 0) pending.push({
    id: "running", href: "#active-job", label: "処理状況を確認",
    shortLabel: "実行中の処理 " + activeJobCount + "件",
    description: "解析処理が実行中です。完了後にルールの状態を確認してください。",
  });

  if (!pending.length) {
    if (jobCount === 0) return {
      primary: {
        id: "awaiting-analysis", href: "#repositories", label: "接続設定を確認",
        shortLabel: "解析準備中",
        description: "リポジトリは登録されていますが、解析ジョブの記録はまだありません。連携設定を確認してください。",
      },
    };
    return {
      primary: {
        id: "rules", href: basePath + "/rules",
        label: "ルール一覧を確認", shortLabel: "ルール一覧",
        description: "現在のルールを確認できます。変更後はずれの検知結果も確認してください。",
      },
    };
  }
  return { primary: pending[0], secondary: pending[1] };
}
