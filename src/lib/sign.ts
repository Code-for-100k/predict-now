import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// Required for @noble/ed25519 v2
ed.etc.sha512Sync = sha512;

/** Generate a fresh Ed25519 key pair. Returns base64-encoded keys. */
export function generateKeyPair(): {
  privateKey: string;
  publicKey: string;
} {
  const privateKeyBytes = ed.utils.randomPrivateKey();
  const publicKeyBytes = ed.getPublicKey(privateKeyBytes);

  return {
    privateKey: Buffer.from(privateKeyBytes).toString("base64"),
    publicKey: Buffer.from(publicKeyBytes).toString("base64"),
  };
}

/** Get the public key (base64) from a private key (base64). */
export function getPublicKey(privateKeyBase64: string): string {
  const privateKeyBytes = Buffer.from(privateKeyBase64, "base64");
  const publicKeyBytes = ed.getPublicKey(privateKeyBytes);
  return Buffer.from(publicKeyBytes).toString("base64");
}

/** Sign a base64-encoded hash with a base64-encoded private key. Returns base64 signature. */
export function signHash(
  hashBase64: string,
  privateKeyBase64: string
): string {
  const hashBytes = Buffer.from(hashBase64, "base64");
  const privateKeyBytes = Buffer.from(privateKeyBase64, "base64");
  const signatureBytes = ed.sign(hashBytes, privateKeyBytes);
  return Buffer.from(signatureBytes).toString("base64");
}
