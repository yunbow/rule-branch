/**
 * Owns one asynchronous request generation. Starting a new generation aborts
 * the previous request and gives callers a commit guard for late resolutions.
 */
export class LatestRequest {
  private generation = 0;
  private controller: AbortController | null = null;

  begin(): { signal: AbortSignal; isCurrent: () => boolean } {
    this.controller?.abort();
    const controller = new AbortController();
    const generation = ++this.generation;
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.generation === generation && !controller.signal.aborted,
    };
  }

  invalidate(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }
}

export function isAbortError(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && "name" in reason
    && (reason as { name?: unknown }).name === "AbortError";
}
