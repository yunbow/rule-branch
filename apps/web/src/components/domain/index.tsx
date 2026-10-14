import { Badge } from "../ui/index.tsx"; import { AI_PROPOSAL_NOTICE, SYSTEM_DETECTED_NOTICE } from "../../lib/messages.ts"; import { getStatusLabel } from "../../lib/labels.ts";
export const AiNotice=()=> <p className="notice">{AI_PROPOSAL_NOTICE}</p>;
export const ProvenanceBadge=({sourceType}:{sourceType:string})=>{const value=getStatusLabel("provenance",sourceType);return <Badge tone={value.tone}>{value.label}</Badge>;};
export const InjectionWarningBadge=()=> <Badge tone="amber">注意: 入力に指示的文言が含まれていました</Badge>;
export { SYSTEM_DETECTED_NOTICE };
