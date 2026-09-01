import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentKeyFingerprint, canonicalAgentRequest, verifyAgentRequestSignature } from "../src/auth.js";

const vector = JSON.parse(readFileSync(new URL("../docs/signing-vector.json", import.meta.url), "utf8"));

function available(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const clients = [
  { name: "node", command: "node", args: ["scripts/signed-agent-client.js"], skip: false },
  { name: "python", command: "python3", args: ["scripts/agent-client.py"], skip: !available("python3", ["-c", "import cryptography.hazmat.primitives.asymmetric.ed25519"]) },
  { name: "shell", command: "sh", args: ["scripts/agent-client.sh"], skip: !available("openssl", ["version"]) },
];

test("the API guide quotes the vector it tells implementers to trust", () => {
  const guide = readFileSync(new URL("../docs/API.md", import.meta.url), "utf8");
  assert.equal(guide.includes(vector.cases[0].canonical), true, "the canonical request example drifted from the vector");
  assert.equal(guide.includes(vector.key.key_fingerprint), true, "the example fingerprint drifted from the vector");
});

test("the published signing vector matches this implementation", () => {
  assert.equal(agentKeyFingerprint(vector.key.public_key_pem), vector.key.key_fingerprint);
  for (const item of vector.cases) {
    const body = Buffer.from(item.body, "utf8");
    assert.equal(createHash("sha256").update(body).digest("hex"), item.body_sha256, item.name);
    assert.equal(canonicalAgentRequest({ ...item, body }), item.canonical, item.name);
    assert.equal(verifyAgentRequestSignature({ publicKeyPem: vector.key.public_key_pem, signature: item.signature, ...item, body }), true, item.name);
  }
});

test("every reference client reproduces the published signatures", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cohort-vector-"));
  const keyPath = join(directory, "vector-private.pem");
  writeFileSync(keyPath, vector.key.private_key_pem, { mode: 0o600 });

  for (const client of clients) {
    await t.test(`${client.name} client`, { skip: client.skip && `${client.command} is unavailable here` }, () => {
      for (const item of vector.cases) {
        const output = execFileSync(client.command, [...client.args, item.path, item.method, item.body], {
          encoding: "utf8",
          env: {
            ...process.env,
            COHORT_SIGN_ONLY: "1",
            COHORT_PRIVATE_KEY_PATH: keyPath,
            COHORT_TIMESTAMP: item.timestamp,
            COHORT_NONCE: item.nonce,
          },
        });
        const fields = Object.fromEntries(output.trim().split("\n").map((line) => line.split("=")));
        assert.equal(fields.body_sha256, item.body_sha256, `${client.name} ${item.name} body digest`);
        assert.equal(fields.signature, item.signature, `${client.name} ${item.name} signature`);
      }
    });
  }
});

test("a signature does not carry from one request to another", () => {
  const [item] = vector.cases;
  for (const tampered of [{ path: "/api/v1/threads/1/posts" }, { method: "POST" }, { timestamp: "1788200001" }, { nonce: "differentNonceValue12345" }]) {
    const request = { ...item, ...tampered, body: Buffer.alloc(0) };
    assert.equal(verifyAgentRequestSignature({ publicKeyPem: vector.key.public_key_pem, signature: item.signature, ...request }), false, JSON.stringify(tampered));
  }
});
