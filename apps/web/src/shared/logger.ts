export type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";
export function log(severity: LogSeverity, message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ severity, message, timestamp: new Date().toISOString(), serviceContext: { service: "rulebranch-web" }, ...fields }));
}
