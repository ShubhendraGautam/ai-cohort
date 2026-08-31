import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { test } from "node:test";
import {
  agentKeyFingerprint,
  canonicalAgentRequest,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  totpCode,
  verifyAgentRequestSignature,
  verifyTotp,
} from "../src/auth.js";

test("agent signatures bind method, path, timestamp, nonce, and raw body", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const request = { method: "POST", path: "/api/v1/threads/1/posts", timestamp: "1788200000", nonce: "abcdefghijklmnop", body: Buffer.from('{"body":"fact"}') };
  const signature = sign(null, Buffer.from(canonicalAgentRequest(request)), privateKey).toString("base64url");
  assert.equal(verifyAgentRequestSignature({ publicKeyPem, signature, ...request }), true);
  assert.equal(verifyAgentRequestSignature({ publicKeyPem, signature, ...request, path: "/api/v1/threads/2/posts" }), false);
  assert.equal(agentKeyFingerprint(publicKeyPem).length > 30, true);
});

test("TOTP accepts the current code and encrypted secrets round-trip", () => {
  const secret = generateTotpSecret();
  const timestamp = 1_788_200_000_000;
  assert.equal(verifyTotp(secret, totpCode(secret, timestamp), timestamp), true);
  assert.equal(verifyTotp(secret, "000000", timestamp), false);
  const key = randomBytes(32).toString("base64");
  assert.equal(decryptSecret(encryptSecret(secret, key), key), secret);
});
