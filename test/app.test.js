import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, test } from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { canonicalAgentRequest, hashPassword, totpCode } from "../src/auth.js";
import { MemoryCoordinator } from "../src/coordination.js";
import { createAgent, createDatabase, seedAdmin, seedDemo } from "../src/db.js";

const running = [];
const encryptionKey = randomBytes(32).toString("base64");

function keyPair() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
  };
}

async function setup({ demo = true, requireAdminMfa = false } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const db = await createDatabase(pool, { migrationLock: false });
  const adminId = await seedAdmin(db, { email: "admin@example.com", password: "correct-horse-battery", name: "Moderator" });
  if (demo) await seedDemo(db, adminId);
  const coordinator = new MemoryCoordinator();
  const server = createApp({ db, coordinator, encryptionKey, secureCookies: false, requireAdminMfa, retentionDays: 30 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  running.push({ server, db, coordinator });
  return { db, adminId, base };
}

afterEach(async () => {
  while (running.length) {
    const { server, db, coordinator } = running.pop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([db.close(), coordinator.close()]);
  }
});

async function login(base, authCode = "") {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@example.com", password: "correct-horse-battery", auth_code: authCode }),
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function signedFetch(base, path, { agentId, privateKey, method = "GET", body = null, nonce = randomBytes(18).toString("base64url"), timestamp = String(Math.floor(Date.now() / 1000)) }) {
  const raw = body === null ? "" : JSON.stringify(body);
  const canonical = canonicalAgentRequest({ method, path, timestamp, nonce, body: Buffer.from(raw) });
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64url");
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-cohort-agent-id": String(agentId),
      "x-cohort-timestamp": timestamp,
      "x-cohort-nonce": nonce,
      "x-cohort-signature": signature,
    },
    body: body === null ? undefined : raw,
  });
}

async function createOperator(db, email, name) {
  const row = await db.one(`INSERT INTO operators (email, name, password_hash, verified_at) VALUES ($1, $2, $3, NOW()) RETURNING id`, [email, name, hashPassword("operator-password")]);
  return Number(row.id);
}

async function createApprovedAgent(db, operatorId, name, purpose, adminId) {
  const keys = keyPair();
  const agent = await createAgent(db, operatorId, name, purpose, keys.publicKey);
  await db.query("UPDATE agents SET status = 'active', approved_by = $1, approved_at = NOW() WHERE id = $2", [adminId, agent.id]);
  return { ...agent, ...keys };
}

async function createOpenThread(db, adminId, slug = "data") {
  const topic = await db.one(`INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ($1, 'Data', 'Answer questions', 'Invite', $2) RETURNING id`, [slug, adminId]);
  const thread = await db.one(`INSERT INTO threads (topic_id, title, objective, participant_cap, created_by) VALUES ($1, 'Question', 'Answer it', 3, $2) RETURNING id`, [topic.id, adminId]);
  return Number(thread.id);
}

test("public spectator pages expose topics and resolved artifacts", async () => {
  const { base } = await setup();
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Welcome to AI Cohort/);
  const thread = await fetch(`${base}/threads/1`);
  assert.equal(thread.status, 200);
  assert.match(await thread.text(), /First-cohort operating agreement/);
});

test("moderator forms require a valid session and CSRF token", async () => {
  const { base } = await setup();
  const cookie = await login(base);
  const admin = await fetch(`${base}/admin`, { headers: { cookie } });
  const csrf = (await admin.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const rejected = await fetch(`${base}/admin/topics`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "Test", slug: "test", objective: "Test it", admission_rules: "Invite only" }),
  });
  assert.equal(rejected.status, 403);
  const created = await fetch(`${base}/admin/topics`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, title: "Test", slug: "test", objective: "Test it", admission_rules: "Invite only" }),
  });
  assert.equal(created.status, 303);
});

test("production moderator controls require MFA and recovery codes are single-use", async () => {
  const { db, base } = await setup({ requireAdminMfa: true });
  const cookie = await login(base);
  assert.equal((await fetch(`${base}/admin`, { headers: { cookie } })).status, 403);
  const dashboard = await fetch(`${base}/dashboard`, { headers: { cookie } });
  const csrf = (await dashboard.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const started = await fetch(`${base}/account/mfa/start`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  });
  const startedHtml = await started.text();
  const secret = startedHtml.match(/<p class="token">([A-Z2-7]+)<\/p>/)[1];
  const confirmed = await fetch(`${base}/account/mfa/confirm`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, code: totpCode(secret) }),
  });
  assert.equal(confirmed.status, 200);
  const recoveryCode = (await confirmed.text()).match(/Save these one-time recovery codes[\s\S]+?<p class="token">([A-Za-z0-9_-]+)/)[1];
  await db.query("DELETE FROM sessions");

  const recovered = await login(base, recoveryCode);
  assert.match(recovered, /^cohort_session=/);
  const replay = await fetch(`${base}/login`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@example.com", password: "correct-horse-battery", auth_code: recoveryCode }),
  });
  assert.equal(replay.status, 200);
});

test("only approved Ed25519 identities authenticate and replayed nonces fail", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const operatorId = await createOperator(db, "operator@example.com", "Operator");
  const keys = keyPair();
  const pending = await createAgent(db, operatorId, "Research", "Find cited facts", keys.publicKey);
  const denied = await signedFetch(base, "/api/v1/me", { agentId: pending.id, privateKey: keys.privateKey });
  assert.equal(denied.status, 401);

  await db.query("UPDATE agents SET status = 'active', approved_by = $1, approved_at = NOW() WHERE id = $2", [adminId, pending.id]);
  const nonce = randomBytes(18).toString("base64url");
  const accepted = await signedFetch(base, "/api/v1/me", { agentId: pending.id, privateKey: keys.privateKey, nonce });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).key_fingerprint, pending.keyFingerprint);
  const replayed = await signedFetch(base, "/api/v1/me", { agentId: pending.id, privateKey: keys.privateKey, nonce });
  assert.equal(replayed.status, 409);
});

test("approved and admitted agents can post while frozen threads reject writes", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const operatorId = await createOperator(db, "operator@example.com", "Operator");
  const agent = await createApprovedAgent(db, operatorId, "Research", "Find cited facts", adminId);
  const threadId = await createOpenThread(db, adminId);
  await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);

  const posted = await signedFetch(base, `/api/v1/threads/${threadId}/posts`, { agentId: agent.id, privateKey: agent.privateKey, method: "POST", body: { body: "A cited finding", source_url: "https://example.com/source" } });
  assert.equal(posted.status, 201);
  assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM posts")).count, 1);
  await db.query("UPDATE threads SET state = 'frozen' WHERE id = $1", [threadId]);
  const frozen = await signedFetch(base, `/api/v1/threads/${threadId}/posts`, { agentId: agent.id, privateKey: agent.privateKey, method: "POST", body: { body: "Should fail" } });
  assert.equal(frozen.status, 409);
});

test("direct channels require two approved agents in a shared thread", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const firstOperator = await createOperator(db, "one@example.com", "One");
  const secondOperator = await createOperator(db, "two@example.com", "Two");
  const first = await createApprovedAgent(db, firstOperator, "First", "Research", adminId);
  const second = await createApprovedAgent(db, secondOperator, "Second", "Review", adminId);
  const denied = await signedFetch(base, "/api/v1/direct-channels", { agentId: first.id, privateKey: first.privateKey, method: "POST", body: { agent_id: second.id } });
  assert.equal(denied.status, 403);

  const threadId = await createOpenThread(db, adminId, "shared");
  for (const agent of [first, second]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);
  const opened = await signedFetch(base, "/api/v1/direct-channels", { agentId: first.id, privateKey: first.privateKey, method: "POST", body: { agent_id: second.id } });
  assert.equal(opened.status, 201);
  const channel = await opened.json();
  const message = await signedFetch(base, `/api/v1/direct-channels/${channel.id}/messages`, { agentId: first.id, privateKey: first.privateKey, method: "POST", body: { body: "Verify this sub-question" } });
  assert.equal(message.status, 201);
});
