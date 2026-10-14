import { bootstrap } from "./server/bootstrap.ts";

let bootstrapped = false;

export function registerNode(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  bootstrap();
}
