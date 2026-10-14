"use server";
import { getRuntime } from "../shared/runtime.ts";
import { listProjectJobs } from "../shared/analysis-jobs.ts";
import { getRequestWorkspaceAccess, requireRole } from "../shared/authz.ts";
export async function getWorkspaceAccess(workspaceId:string,userId:string) { const store=getRuntime().store; return store ? getRequestWorkspaceAccess(store,workspaceId,userId) : {workspace:null,membership:null,role:null,workspaceDeleted:false}; }
export async function getWorkspaceMembership(workspaceId:string,userId:string) { return (await getWorkspaceAccess(workspaceId,userId)).membership; }
export async function getMyWorkspaces(userId:string) { const store=getRuntime().store; if(!store) return []; const members=(await store.findServerDocuments("workspace_members",{userId})).filter(m=>!m.deletedAt); return (await store.getServerDocuments("workspaces",members.map(m=>String(m.workspaceId)))).filter(w=>w.status!=="deleted"&&!w.deletedAt); }
export async function getProjects(workspaceId:string,userId:string) { const r=getRuntime(); return r.projectRepositories?.listProjects(workspaceId,userId) ?? []; }
export async function getRules(workspaceId:string,userId:string) { const r=getRuntime(); return r.rules?.listRules(workspaceId,userId) ?? []; }
export async function getRuleRelations(workspaceId:string,userId:string) { const r=getRuntime(); return r.rules?.listRelations(workspaceId,userId) ?? []; }
export async function getMyInvitations(userId: string) { const service = getRuntime().workspaceInvitations; return service ? service.listMyInvitations(userId) : []; }
export async function getWorkspaceMembers(workspaceId: string, userId: string) { const service = getRuntime().workspaceInvitations; return service ? service.listMembers(workspaceId, userId) : []; }
export async function getPendingWorkspaceInvitations(workspaceId: string, userId: string) { const service = getRuntime().workspaceInvitations; return service ? service.listPendingInvitations(workspaceId, userId) : []; }
export async function getProjectJobs(workspaceId: string, userId: string, projectId: string) { const store = getRuntime().store; if(!store)return []; await requireRole(store,workspaceId,userId,"viewer"); return listProjectJobs(store, { workspaceId, actorUserId: userId }, projectId); }
