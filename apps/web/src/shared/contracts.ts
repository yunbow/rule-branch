import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export type EnumCatalog = Readonly<Record<string, readonly string[]>>;
export type Limits = Readonly<Record<string, unknown>>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}
function requireStringArrays(value: unknown): EnumCatalog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid enum contract");
  for (const values of Object.values(value as Record<string, unknown>)) {
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) throw new Error("Invalid enum contract");
  }
  return Object.freeze(value as Record<string, readonly string[]>);
}

export const ENUMS = requireStringArrays(loadJson("contracts/enums.json"));
export const LIMITS = Object.freeze(loadJson("contracts/limits.json") as Limits);
export type EnumName = keyof typeof ENUMS;
export type EnumValue<Name extends EnumName> = (typeof ENUMS)[Name][number];

// GOV fields from DM 2.5. Later domain tickets extend this shared contract.
export interface GovernanceFields {
  ownerWorkspaceId: string;
  scopeType: EnumValue<"scopeType">;
  scopeId: string;
  visibility: EnumValue<"visibility">;
  enforcement: EnumValue<"enforcement"> | null;
  transferPolicy: EnumValue<"transferPolicy">;
  licenseType: EnumValue<"licenseType">;
  provenance: { sourceType: EnumValue<"provenance.sourceType">; sourceRef: string; model?: string; promptVersion?: string; inputDigest?: string; originWorkspaceId?: string; originEntityId?: string; derivedFromCustomerCode: boolean };
  containsPersonalData: boolean;
  containsConfidentialData: boolean;
  retentionClass: EnumValue<"retentionClass">;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  createdBy: { kind: EnumValue<"createdBy.kind">; id: string };
}
