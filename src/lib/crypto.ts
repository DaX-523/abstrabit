import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for values that must never be shown back to
 * the browser in full: mirror webhook URLs, Discord interaction tokens held
 * in job payloads. Ciphertext format is a single base64 string:
 *   base64(iv[12] || authTag[16] || ciphertext)
 * so it's one column, one string, no extra bookkeeping.
 *
 * Reads ENCRYPTION_KEY directly from process.env rather than going through
 * the full env.ts schema, so this module (and its tests) don't need every
 * other environment variable to be set just to encrypt/decrypt one value.
 */

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decrypt(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < 12 + 16) {
    throw new Error("Ciphertext too short to contain iv + auth tag");
  }
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Masks a URL for display in the dashboard: shows the host and the last 4
 * characters of the path/token, hides everything else. Never send the
 * decrypted value itself to the client — only ever this.
 */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.slice(-4).replace(/[^A-Za-z0-9]/g, "") || "????";
    return `${parsed.host}/…/•••${tail}`;
  } catch {
    return "•••invalid-url";
  }
}
