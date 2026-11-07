import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const ORIGIN_SIGNATURE_CACHE_LIMITS = Object.freeze({
  keys: 128,
  keyBytes: 256 * 1024,
  keyCodeUnits: 1024,
  verifications: 16_384,
  verificationBytes: 16 * 1024 * 1024,
  verificationEntryBytes: 128 * 1024,
});

/** Reuses cryptographic facts only. Callers must still parse and authorize every current state. */
export class OriginSignatureVerifier {
  private readonly keys = new Map<string, { key: KeyObject; bytes: number }>();
  private readonly successes = new Map<string, number>();
  private keyBytes = 0;
  private verificationBytes = 0;

  parsePublicKey(publicKey: string): KeyObject {
    const cached = this.keys.get(publicKey);
    if (cached) {
      return cached.key;
    }

    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519" || publicKey.length > ORIGIN_SIGNATURE_CACHE_LIMITS.keyCodeUnits) {
      return key;
    }

    // Two bytes per code unit plus an allowance for the fixed-size Ed25519 KeyObject and map entry.
    // This bounds retained inputs and entries; qualification measures actual heap/RSS separately.
    const bytes = publicKey.length * 2 + 512;
    for (const [oldest, entry] of this.keys) {
      if (this.keys.size < ORIGIN_SIGNATURE_CACHE_LIMITS.keys && this.keyBytes + bytes <= ORIGIN_SIGNATURE_CACHE_LIMITS.keyBytes) {
        break;
      }

      this.keys.delete(oldest);
      this.keyBytes -= entry.bytes;
    }

    this.keys.set(copyText(publicKey), { key, bytes });
    this.keyBytes += bytes;
    return key;
  }

  verify(publicKey: string, signature: string, signedBytes: Buffer): void {
    // Latin-1 preserves every byte. Length prefixes make the tuple unambiguous without hashing.
    // The immutable text also owns the input before verification, including caller-owned Buffers.
    const message = signedBytes.toString("latin1");
    const prefix = `${publicKey.length}:${publicKey}${signature.length}:${signature}`;
    const bytes = (prefix.length + message.length) * 2 + 256;
    const identity = bytes <= ORIGIN_SIGNATURE_CACHE_LIMITS.verificationEntryBytes ? prefix + message : undefined;
    if (identity !== undefined && this.successes.has(identity)) {
      return;
    }

    const key = this.parsePublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(message, "latin1"), key, Buffer.from(signature, "base64url"))) {
      throw new Error("Origin signature verification failed");
    }

    if (identity === undefined) {
      return;
    }

    for (const [oldest, retainedBytes] of this.successes) {
      if (this.successes.size < ORIGIN_SIGNATURE_CACHE_LIMITS.verifications && this.verificationBytes + bytes <= ORIGIN_SIGNATURE_CACHE_LIMITS.verificationBytes) {
        break;
      }

      this.successes.delete(oldest);
      this.verificationBytes -= retainedBytes;
    }

    this.successes.set(copyText(identity), bytes);
    this.verificationBytes += bytes;
  }

  usage() {
    return { keys: this.keys.size, keyBytes: this.keyBytes, verifications: this.successes.size, verificationBytes: this.verificationBytes };
  }
}

function copyText(value: string): string {
  // Detach retained text from caller substrings or ropes backed by much larger input strings.
  return Buffer.from(value, "utf16le").toString("utf16le");
}
