import { isBelowStaleThreshold } from "../../lib/drift-list.ts";
export { isBelowStaleThreshold } from "../../lib/drift-list.ts";
export function ConfidenceBar({ confidence, severity }: { confidence: number; severity: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(confidence * 100)));
  return <div><div role="progressbar" aria-label={`確信度 ${percent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={{ minWidth: "8rem" }}><span style={{ display: "inline-block", width: `${percent}%`, minWidth: percent ? "2px" : undefined }} className="confidenceBar"/>{percent}%</div>{isBelowStaleThreshold(severity, confidence) && <small>この重要度・確信度では要確認への自動切り替えは発生しません</small>}</div>;
}
export default ConfidenceBar;
