// Invite code shape: 16 chars from Crockford base32 (no I/L/O/U).
// Stored canonically (uppercase, no dashes); displayed XXXX-XXXX-XXXX-XXXX.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 chars
const LENGTH = 16;

export function generateInviteCode(): string {
  const bytes = randomBytes(LENGTH);
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function canonicalize(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

export function formatForDisplay(canonical: string): string {
  return canonical.match(/.{1,4}/g)?.join("-") ?? canonical;
}

export function isValidShape(canonical: string): boolean {
  if (canonical.length !== LENGTH) return false;
  for (const c of canonical) if (!ALPHABET.includes(c)) return false;
  return true;
}
