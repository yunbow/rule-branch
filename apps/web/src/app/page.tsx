import { redirect } from "next/navigation";
import { getSessionUser } from "../server/session.ts";
export default async function Page() { const user=await getSessionUser(); redirect(user ? `/w/${user.personalWorkspaceId}` : "/login"); }
