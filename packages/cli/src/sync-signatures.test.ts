import assert from "node:assert/strict";
import crypto, { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { ORIGIN_SIGNATURE_CACHE_LIMITS, OriginSignatureVerifier } from "./sync-signatures";

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    signature: (bytes: Buffer) => sign(null, bytes, privateKey).toString("base64url") };
}

test("exact successes reuse crypto; changed key, signature and bytes fail repeatedly after warmup", (t) => {
  const verifier = new OriginSignatureVerifier();
  const owner = signer();
  const other = signer();
  const bytes = Buffer.from([0, 255, 128, 58, 0, 1]);
  const signature = owner.signature(bytes);
  const verify = t.mock.method(crypto, "verify", crypto.verify);
  const parseKey = t.mock.method(crypto, "createPublicKey", crypto.createPublicKey);

  verifier.verify(owner.publicKey, signature, bytes);
  verifier.verify(owner.publicKey, signature, Buffer.from(bytes));
  assert.equal(verify.mock.callCount(), 1);
  assert.equal(parseKey.mock.callCount(), 1);

  const invalidSignature = other.signature(bytes);
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => verifier.verify(other.publicKey, signature, bytes), /signature verification failed/);
    assert.throws(() => verifier.verify(owner.publicKey, invalidSignature, bytes), /signature verification failed/);
    assert.throws(() => verifier.verify(owner.publicKey, signature, changed), /signature verification failed/);
  }

  assert.equal(verify.mock.callCount(), 7);
  assert.equal(verifier.usage().verifications, 1);
  assert.equal(parseKey.mock.callCount(), 2);
});

test("equivalent PEM or base64 decodings still use separate exact text inputs", (t) => {
  const verifier = new OriginSignatureVerifier();
  const owner = signer();
  const bytes = Buffer.from("exact tuple");
  const signature = owner.signature(bytes);
  const verify = t.mock.method(crypto, "verify", crypto.verify);
  verifier.verify(owner.publicKey, signature, bytes);
  verifier.verify(owner.publicKey + "\n", signature, bytes);
  verifier.verify(owner.publicKey, signature + "==", bytes);
  verifier.verify(owner.publicKey, signature, bytes);

  assert.equal(verify.mock.callCount(), 3);
  assert.equal(verifier.usage().verifications, 3);
});

test("retained verification inputs own Buffer bytes rather than caller identity", () => {
  const verifier = new OriginSignatureVerifier();
  const owner = signer();
  const bytes = Buffer.from("before");
  const signature = owner.signature(bytes);
  verifier.verify(owner.publicKey, signature, bytes);
  bytes.fill(0);

  assert.throws(() => verifier.verify(owner.publicKey, signature, bytes), /signature verification failed/);
  verifier.verify(owner.publicKey, signature, Buffer.from("before"));
  assert.equal(verifier.usage().verifications, 1);
});

test("malformed and non-Ed25519 keys are never retained as successful keys or verifications", (t) => {
  const verifier = new OriginSignatureVerifier();
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const parseKey = t.mock.method(crypto, "createPublicKey", crypto.createPublicKey);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => verifier.parsePublicKey("invalid key"));
    assert.throws(() => verifier.verify(pem, "invalid", Buffer.from("bytes")), /signature verification failed/);
  }

  assert.equal(parseKey.mock.callCount(), 4);
  assert.deepEqual(verifier.usage(), { keys: 0, keyBytes: 0, verifications: 0, verificationBytes: 0 });
});

test("key reuse is globally entry/byte bounded and evicts the oldest parsed key", (t) => {
  const verifier = new OriginSignatureVerifier();
  const owner = signer();
  const parseKey = t.mock.method(crypto, "createPublicKey", crypto.createPublicKey);
  verifier.parsePublicKey(owner.publicKey);
  for (let index = 1; index <= ORIGIN_SIGNATURE_CACHE_LIMITS.keys; index += 1) {
    // PEM whitespace varies the exact input without generating hundreds of cryptographic keys.
    verifier.parsePublicKey(owner.publicKey + "\n".repeat(index));
  }

  assert.equal(verifier.usage().keys, ORIGIN_SIGNATURE_CACHE_LIMITS.keys);
  assert.ok(verifier.usage().keyBytes <= ORIGIN_SIGNATURE_CACHE_LIMITS.keyBytes);
  verifier.parsePublicKey(owner.publicKey);
  assert.equal(parseKey.mock.callCount(), ORIGIN_SIGNATURE_CACHE_LIMITS.keys + 2);

  const before = verifier.usage();
  const oversizedKey = owner.publicKey + "\n".repeat(ORIGIN_SIGNATURE_CACHE_LIMITS.keyCodeUnits);
  verifier.parsePublicKey(oversizedKey);
  verifier.parsePublicKey(oversizedKey);
  assert.deepEqual(verifier.usage(), before);
  assert.equal(parseKey.mock.callCount(), ORIGIN_SIGNATURE_CACHE_LIMITS.keys + 4);
});

test("parsed-key byte allowance can evict before the key entry limit", () => {
  const verifier = new OriginSignatureVerifier();
  const owner = signer();
  for (let index = 0; index < ORIGIN_SIGNATURE_CACHE_LIMITS.keys; index += 1) {
    const suffix = index.toString(2).padStart(8, "0").replaceAll("0", " ").replaceAll("1", "\t");
    verifier.parsePublicKey(owner.publicKey + "\n".repeat(850) + suffix);
    assert.ok(verifier.usage().keyBytes <= ORIGIN_SIGNATURE_CACHE_LIMITS.keyBytes);
  }

  assert.ok(verifier.usage().keys < ORIGIN_SIGNATURE_CACHE_LIMITS.keys);
});

test("success entry bound evicts old inputs and evicted invalid mutations still fail", (t) => {
  const verifier = new OriginSignatureVerifier();
  const owner = signer();
  const bytes = Buffer.from("old success");
  const signature = owner.signature(bytes);
  verifier.verify(owner.publicKey, signature, bytes);
  // Exercise retention with a cheap crypto stand-in, then restore real verification for eviction.
  const verify = t.mock.method(crypto, "verify", () => true);
  for (let index = 0; index < ORIGIN_SIGNATURE_CACHE_LIMITS.verifications; index += 1) {
    verifier.verify(owner.publicKey, signature, Buffer.from(String(index)));
  }

  assert.equal(verifier.usage().verifications, ORIGIN_SIGNATURE_CACHE_LIMITS.verifications);
  assert.ok(verifier.usage().verificationBytes <= ORIGIN_SIGNATURE_CACHE_LIMITS.verificationBytes);
  verify.mock.restore();
  const realVerify = t.mock.method(crypto, "verify", crypto.verify);
  verifier.verify(owner.publicKey, signature, bytes);
  assert.equal(realVerify.mock.callCount(), 1);
  assert.throws(() => verifier.verify(owner.publicKey, signature, Buffer.from("old failure")), /signature verification failed/);
});

test("retained-byte bound evicts before entry capacity; oversized successes bypass without flushing", (t) => {
  const verifier = new OriginSignatureVerifier();
  const owner = signer();
  const bytes = Buffer.alloc(32 * 1024, 255);
  const signature = owner.signature(bytes);
  verifier.verify(owner.publicKey, signature, bytes);
  const verify = t.mock.method(crypto, "verify", () => true);
  for (let index = 0; index < 300; index += 1) {
    const changed = Buffer.from(bytes);
    changed.writeUInt32LE(index);
    verifier.verify(owner.publicKey, signature, changed);
    assert.ok(verifier.usage().verificationBytes <= ORIGIN_SIGNATURE_CACHE_LIMITS.verificationBytes);
  }

  assert.ok(verifier.usage().verifications < 300);
  verify.mock.restore();
  const realVerify = t.mock.method(crypto, "verify", crypto.verify);
  verifier.verify(owner.publicKey, signature, bytes);
  assert.equal(realVerify.mock.callCount(), 1);

  const before = verifier.usage();
  const oversized = Buffer.alloc(ORIGIN_SIGNATURE_CACHE_LIMITS.verificationEntryBytes, 255);
  const oversizedSignature = owner.signature(oversized);
  verifier.verify(owner.publicKey, oversizedSignature, oversized);
  verifier.verify(owner.publicKey, oversizedSignature, oversized);
  assert.deepEqual(verifier.usage(), before);
  assert.equal(realVerify.mock.callCount(), 3);
});
