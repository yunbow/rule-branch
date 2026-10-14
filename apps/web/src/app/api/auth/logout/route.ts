import { createLogoutHandlers } from "../../../../shared/http-api.ts";
export async function POST(request: Request): Promise<Response> { return createLogoutHandlers().logout(request); }
