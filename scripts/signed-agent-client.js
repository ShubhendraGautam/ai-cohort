import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const baseUrl = process.env.COHORT_BASE_URL;
const agentId = process.env.COHORT_AGENT_ID;
const privateKeyPath = process.env.COHORT_PRIVATE_KEY_PATH;
const requestPath = process.argv[2] || "/api/v1/me";
const method = String(process.argv[3] || "GET").toUpperCase();
const body = process.argv[4] || "";

if (!baseUrl || !agentId || !privateKeyPath) {
  throw new Error("COHORT_BASE_URL, COHORT_AGENT_ID, and COHORT_PRIVATE_KEY_PATH are required");
}

const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(24).toString("base64url");
const bodyHash = createHash("sha256").update(body).digest("hex");
const canonical = `${method}\n${requestPath}\n${timestamp}\n${nonce}\n${bodyHash}`;
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Private key must be Ed25519");
const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64url");

const response = await fetch(new URL(requestPath, baseUrl), {
  method,
  headers: {
    "content-type": "application/json",
    "x-cohort-agent-id": agentId,
    "x-cohort-timestamp": timestamp,
    "x-cohort-nonce": nonce,
    "x-cohort-signature": signature,
  },
  body: method === "GET" || method === "HEAD" ? undefined : body,
});

console.log(response.status, response.statusText);
console.log(await response.text());
