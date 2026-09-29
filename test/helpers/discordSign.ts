import nacl from "tweetnacl";

/** A fixed dev keypair + signer, shared by tests and scripts/simulate.ts, so
 * requests can be signed exactly like Discord would without ever touching a
 * real application's public key. */
export function makeDevKeypair() {
  const { publicKey, secretKey } = nacl.sign.keyPair();
  return {
    publicKeyHex: Buffer.from(publicKey).toString("hex"),
    sign(timestamp: string, rawBody: string): string {
      const message = Buffer.from(timestamp + rawBody, "utf8");
      const signature = nacl.sign.detached(message, secretKey);
      return Buffer.from(signature).toString("hex");
    },
  };
}
