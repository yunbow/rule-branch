"use client";
import type { ShellWorkspace } from "../../lib/shell-me.ts";
export function WorkspaceSwitcher({ workspaceId, workspaces = [] }: { workspaceId: string; workspaces?: ShellWorkspace[] }) {
  return <label>Workspace <select aria-label="Workspace を切替" value={workspaceId} onChange={(event) => { const id = event.target.value; document.cookie = `rulebranch_ws=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax`; window.location.assign(`/w/${encodeURIComponent(id)}`); }}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>;
}
export default WorkspaceSwitcher;
