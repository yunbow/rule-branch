"use server";
import { cookies } from "next/headers";
import { verifySession } from "../shared/auth.ts";
import { getRuntime } from "../shared/runtime.ts";
export async function getSessionUser() { const runtime=getRuntime(); if (!runtime.store) return null; const session=verifySession((await cookies()).get("rulebranch_session")?.value,runtime.sessionSecret); if (!session) return null; return (await runtime.store.findServerDocuments("users",{id:session.userId}))[0] ?? null; }
