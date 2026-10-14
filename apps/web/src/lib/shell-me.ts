export type ShellWorkspace = { id: string; name: string; kind: "personal" | "organization"; role: string };
export type ShellMe = { workspaces: ShellWorkspace[]; pendingInvitations: number };

export const EMPTY_SHELL_ME: ShellMe = { workspaces: [], pendingInvitations: 0 };

export async function loadShellMe(fetchMe: () => Promise<ShellMe>): Promise<ShellMe> {
  try { return await fetchMe(); }
  catch { return EMPTY_SHELL_ME; }
}
