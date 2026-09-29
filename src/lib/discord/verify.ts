import nacl from "tweetnacl";

/**
 * Ed25519 request verification for Discord's interactions endpoint.
 * Discord signs `timestamp + rawBody` and sends the signature in
 * X-Signature-Ed25519 (hex) alongside X-Signature-Timestamp (unix seconds,
 * decimal). This MUST run on the raw request body, before any JSON.parse --
 * parsing first and re-serializing to verify would let a byte-for-byte
 * different (but semantically equal) payload slip past.
 *
 * The timestamp window additionally guards against replaying an old, validly
 * signed request; interaction-id dedup (see src/lib/interactions) guards
 * against replaying a *recent* one.
 */

const ED25519_SIGNATURE_HEX_LENGTH = 128; // 64 bytes
const ED25519_PUBLIC_KEY_HEX_LENGTH = 64; // 32 bytes
const HEX_RE = /^[0-9a-f]+$/i;
const DIGITS_RE = /^\d+$/;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

function isHexOfLength(value: string, length: number): boolean {
  return value.length === length && HEX_RE.test(value);
}

export interface VerifyParams {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  /** Injectable for tests; defaults to the real current time. */
  now?: number;
  /** How far a timestamp may drift from `now`, in seconds. */
  maxSkewSeconds?: number;
}

export function verifyDiscordSignature(params: VerifyParams): VerifyResult {
  const {
    rawBody,
    signature,
    timestamp,
    publicKey,
    now = Math.floor(Date.now() / 1000),
    maxSkewSeconds = 300,
  } = params;

  if (!signature || !timestamp) {
    return { ok: false, reason: "missing signature headers" };
  }
  if (!isHexOfLength(signature, ED25519_SIGNATURE_HEX_LENGTH)) {
    return { ok: false, reason: "malformed signature" };
  }
  if (!isHexOfLength(publicKey, ED25519_PUBLIC_KEY_HEX_LENGTH)) {
    return { ok: false, reason: "malformed public key" };
  }
  if (!DIGITS_RE.test(timestamp)) {
    return { ok: false, reason: "malformed timestamp" };
  }

  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > maxSkewSeconds) {
    return { ok: false, reason: "timestamp outside allowed window" };
  }

  const signatureBytes = Buffer.from(signature, "hex");
  const publicKeyBytes = Buffer.from(publicKey, "hex");
  const message = Buffer.from(timestamp + rawBody, "utf8");

  let verified: boolean;
  try {
    verified = nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
  } catch {
    verified = false;
  }

  if (!verified) {
    return { ok: false, reason: "invalid signature" };
  }
  return { ok: true };
}
