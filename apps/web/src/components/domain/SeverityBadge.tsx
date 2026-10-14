import { StatusBadge } from "../ui/index.tsx";
export function SeverityBadge({ severity }: { severity: string }) { return <StatusBadge kind="severity" value={severity}/>; }
export default SeverityBadge;
