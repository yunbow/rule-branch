import { createDriftHandlers } from "../../../../../shared/http-api.ts"; import { getRuntime } from "../../../../../shared/runtime.ts";
export async function POST(r: Request, c: {params:Promise<{id:string}>}) { const x=getRuntime(); if(!x.drift) throw new Error("Drift runtime is not configured"); return createDriftHandlers(x.drift,x.sessionSecret).triage(r,(await c.params).id,"untriage"); }
