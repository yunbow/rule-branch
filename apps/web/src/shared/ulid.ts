import { randomBytes } from "node:crypto";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function encode(value: bigint, length: number): string { let out = ""; for (let i = 0; i < length; i += 1) { out = ALPHABET[Number(value & 31n)] + out; value >>= 5n; } return out; }
export function generateUlid(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("ULID timestamp must be a non-negative integer");
  return encode(BigInt(now), 10) + encode(BigInt("0x" + randomBytes(10).toString("hex")), 16);
}
