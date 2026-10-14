import { ProjectCard } from "./ProjectCard.tsx";
import {
  sortWorkspaceProjects,
  type BootstrapStatus,
  type WorkspaceProjectSummary,
} from "../../lib/workspace-overview.ts";

export function ProjectGrid({
  workspaceId,
  projects,
  canManage = false,
  bootstrapStatusByProject = {},
}: {
  workspaceId: string;
  projects: WorkspaceProjectSummary[];
  canManage?: boolean;
  bootstrapStatusByProject?: Record<string, BootstrapStatus>;
}) {
  return <div className="workspaceProjectGrid">
    {sortWorkspaceProjects(projects).map((project) =>
      <ProjectCard
        key={project.id}
        workspaceId={workspaceId}
        project={project}
        canManage={canManage}
        bootstrapStatus={bootstrapStatusByProject[project.id]}
      />,
    )}
  </div>;
}
