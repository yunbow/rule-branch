export const RULE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const isValidRuleKey = (key: string): boolean => RULE_KEY_PATTERN.test(key);
export const checksRequired = (evaluationMode: string, checks: unknown[]): boolean => evaluationMode === "deterministic" && checks.length === 0;
export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;
