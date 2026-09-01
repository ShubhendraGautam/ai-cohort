import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { AgentCard, Role } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  createAuthenticatingFetchWithRetry,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
} from "@a2a-js/sdk/client";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { canonicalAgentRequest, hashPassword, totpCode } from "../src/auth.js";
import { PRIVATE_COHORT_EXTENSION, storeCohortMessage } from "../src/cohorts/service.js";
import { MemoryCoordinator } from "../src/coordination.js";
import { createAgent, createDatabase, freezeStalledThreads, seedAdmin, seedDemo } from "../src/db.js";
import { receiptDigest } from "../src/threads/receipt.js";

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
  return loginAs(base, "admin@example.com", "correct-horse-battery", authCode);
}

async function loginAs(base, email, password, authCode = "") {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, auth_code: authCode }),
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function csrfFor(base, cookie) {
  const dashboard = await fetch(`${base}/dashboard`, { headers: { cookie } });
  return (await dashboard.text()).match(/name="csrf" value="([^"]+)"/)[1];
}

async function controlFetch(base, path, { cookie, csrf, method = "GET", body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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

test("maintenance auto-freezes stalled threads and queues a system moderation action", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const stalledId = await createOpenThread(db, adminId, "stalled");
  const activeId = await createOpenThread(db, adminId, "active");
  const reference = new Date("2026-09-01T12:00:00.000Z");
  await db.query("UPDATE threads SET updated_at = $1 WHERE id = $2", ["2026-08-24T11:59:59.000Z", stalledId]);
  await db.query("UPDATE threads SET updated_at = $1 WHERE id = $2", ["2026-08-26T12:00:00.000Z", activeId]);

  assert.deepEqual(await freezeStalledThreads(db, { staleAfterDays: 7, now: reference }), [stalledId]);
  assert.deepEqual(await freezeStalledThreads(db, { staleAfterDays: 7, now: reference }), []);
  assert.equal((await db.one("SELECT state FROM threads WHERE id = $1", [stalledId])).state, "frozen");
  assert.equal((await db.one("SELECT state FROM threads WHERE id = $1", [activeId])).state, "open");
  const event = await db.one("SELECT * FROM moderation_events WHERE target_type = 'thread' AND target_id = $1 AND action = 'auto-freeze'", [stalledId]);
  assert.equal(event.actor_type, "system");
  assert.equal(event.moderator_id, null);
  assert.equal(event.metadata.staleAfterDays, 7);

  await createOperator(db, "operator@example.com", "Operator");
  const operatorCookie = await loginAs(base, "operator@example.com", "operator-password");
  assert.equal((await fetch(`${base}/admin`, { headers: { cookie: operatorCookie } })).status, 403);

  const cookie = await login(base);
  const queue = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  assert.match(queue, /Question/);
  assert.match(queue, /frozen/);
  assert.match(queue, /System/);
  assert.match(queue, /auto-freeze/);
  const triage = await (await fetch(`${base}/admin/threads/${stalledId}`, { headers: { cookie } })).text();
  assert.match(triage, /System/);
  assert.match(triage, /No thread activity for 7 days/);
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

test("two owners approve a private assistant cohort and exchange an A2A message", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const aliceId = await createOperator(db, "alice@example.com", "Alice");
  const bobId = await createOperator(db, "bob@example.com", "Bob");
  const aliceAssistant = await createApprovedAgent(db, aliceId, "Alice Assistant", "Coordinate plans", adminId);
  const bobAssistant = await createApprovedAgent(db, bobId, "Bob Assistant", "Protect Bob's preferences", adminId);

  const aliceCookie = await loginAs(base, "alice@example.com", "operator-password");
  const bobCookie = await loginAs(base, "bob@example.com", "operator-password");
  const aliceCsrf = await csrfFor(base, aliceCookie);
  const bobCsrf = await csrfFor(base, bobCookie);

  const invited = await controlFetch(base, "/control/v1/cohort-invitations", {
    cookie: aliceCookie,
    csrf: aliceCsrf,
    method: "POST",
    body: {
      inviterAssistantId: aliceAssistant.id,
      inviteeAssistantId: bobAssistant.id,
      purpose: "Find a mutually convenient meeting time",
      policy: {
        authority: "proposal_only",
        allowedSkills: ["availability.exchange"],
        shareableContext: ["availability.windows"],
        forbiddenContext: ["calendar.event_titles"],
      },
    },
  });
  const invitedBody = await invited.json();
  assert.equal(invited.status, 201, JSON.stringify(invitedBody));
  const invitation = invitedBody.invitation;

  const unilateral = await controlFetch(base, `/control/v1/cohort-invitations/${invitation.id}/accept`, {
    cookie: aliceCookie,
    csrf: aliceCsrf,
    method: "POST",
    body: {},
  });
  assert.equal(unilateral.status, 404);

  const accepted = await controlFetch(base, `/control/v1/cohort-invitations/${invitation.id}/accept`, {
    cookie: bobCookie,
    csrf: bobCsrf,
    method: "POST",
    body: {},
  });
  assert.equal(accepted.status, 200);
  const cohort = (await accepted.json()).cohort;

  const tokenResponse = await signedFetch(base, "/api/v1/token", {
    agentId: aliceAssistant.id,
    privateKey: aliceAssistant.privateKey,
    method: "POST",
  });
  assert.equal(tokenResponse.status, 200);
  const aliceToken = (await tokenResponse.json()).access_token;

  const cardResponse = await fetch(`${base}/.well-known/agent-card.json`, {
    headers: { "a2a-version": "1.0" },
  });
  assert.equal(cardResponse.status, 200);
  const cardJson = await cardResponse.json();
  cardJson.supportedInterfaces[0].url = `${base}/a2a`;
  const card = AgentCard.fromJSON(cardJson);
  const authenticatedFetch = createAuthenticatingFetchWithRetry(fetch, {
    headers: async () => ({ Authorization: `Bearer ${aliceToken}` }),
    shouldRetryWithHeaders: async () => undefined,
  });
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    { transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] },
  ));
  const client = await factory.createFromAgentCard(card);
  const messageId = crypto.randomUUID();
  const result = await client.sendMessage({
    tenant: "",
    message: {
      messageId,
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: "text", value: "Alice is free after 18:00 on Thursday." },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      metadata: {
        [PRIVATE_COHORT_EXTENSION]: {
          cohortId: cohort.id,
          recipientAssistantId: bobAssistant.id,
          contextGrantIds: [],
        },
      },
      extensions: [PRIVATE_COHORT_EXTENSION],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  }, {
    serviceParameters: ServiceParameters.create(withA2AExtensions(PRIVATE_COHORT_EXTENSION)),
  });
  assert.equal(result.role, Role.ROLE_AGENT);

  const bobTokenResponse = await signedFetch(base, "/api/v1/token", {
    agentId: bobAssistant.id,
    privateKey: bobAssistant.privateKey,
    method: "POST",
  });
  const bobToken = (await bobTokenResponse.json()).access_token;
  const inbox = await fetch(`${base}/agent/v1/inbox`, {
    headers: { authorization: `Bearer ${bobToken}` },
  });
  assert.equal(inbox.status, 200);
  const inboxBody = await inbox.json();
  assert.equal(inboxBody.messages.length, 1);
  assert.equal(inboxBody.messages[0].id, messageId);
  const aliceInbox = await fetch(`${base}/agent/v1/inbox`, {
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  assert.equal((await aliceInbox.json()).messages.length, 0);

  const proposalResponse = await fetch(`${base}/agent/v1/cohorts/${cohort.id}/proposals`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${aliceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Thursday meeting",
      body: { startsAt: "2026-09-03T18:30:00+05:30", durationMinutes: 60 },
    }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = (await proposalResponse.json()).proposal;

  const aliceDecision = await controlFetch(base, `/control/v1/approvals/${proposal.id}/decision`, {
    cookie: aliceCookie,
    csrf: aliceCsrf,
    method: "POST",
    body: { decision: "approved" },
  });
  assert.equal((await aliceDecision.json()).proposal.status, "pending");
  const bobDecision = await controlFetch(base, `/control/v1/approvals/${proposal.id}/decision`, {
    cookie: bobCookie,
    csrf: bobCsrf,
    method: "POST",
    body: { decision: "approved" },
  });
  const outcome = await bobDecision.json();
  assert.equal(outcome.proposal.status, "approved");
  assert.match(outcome.receipt.content_hash, /^[a-f0-9]{64}$/);
});

async function formPost(base, path, cookie, fields) {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

test("owners run the whole consent flow from the browser without touching the API", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const aliceId = await createOperator(db, "alice@example.com", "Alice");
  const bobId = await createOperator(db, "bob@example.com", "Bob");
  const aliceAssistant = await createApprovedAgent(db, aliceId, "Alice Assistant", "Coordinate plans", adminId);
  const bobAssistant = await createApprovedAgent(db, bobId, "Bob Assistant", "Protect Bob's preferences", adminId);

  const anonymous = await fetch(`${base}/cohorts`, { redirect: "manual" });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/login");

  const aliceCookie = await loginAs(base, "alice@example.com", "operator-password");
  const bobCookie = await loginAs(base, "bob@example.com", "operator-password");
  const aliceCsrf = await csrfFor(base, aliceCookie);
  const bobCsrf = await csrfFor(base, bobCookie);

  const empty = await fetch(`${base}/cohorts`, { headers: { cookie: aliceCookie } });
  assert.equal(empty.status, 200);
  const emptyBody = await empty.text();
  assert.match(emptyBody, /Invite another owner's assistant/);
  assert.match(emptyBody, new RegExp(`#${aliceAssistant.id}`));
  assert.match(emptyBody, /No private cohorts yet/);

  const invited = await formPost(base, "/cohorts/invitations", aliceCookie, {
    csrf: aliceCsrf,
    inviter_assistant_id: String(aliceAssistant.id),
    invitee_assistant_id: String(bobAssistant.id),
    purpose: "Find a mutually convenient meeting time",
    authority: "proposal_only",
    allowed_skills: "availability.exchange, scheduling.propose",
    shareable_context: "availability.windows",
    forbidden_context: "calendar.event_titles",
  });
  assert.equal(invited.status, 200);
  assert.match(await invited.text(), /Invitation sent/);

  const bobInbox = await fetch(`${base}/cohorts`, { headers: { cookie: bobCookie } });
  const bobInboxBody = await bobInbox.text();
  assert.match(bobInboxBody, /Find a mutually convenient meeting time/);
  assert.match(bobInboxBody, /Withheld: calendar.event_titles/);
  const invitationId = bobInboxBody.match(/\/cohorts\/invitations\/([0-9a-f-]{36})\/accept/)[1];

  const forged = await formPost(base, `/cohorts/invitations/${invitationId}/accept`, bobCookie, {
    csrf: "not-the-session-token",
  });
  assert.equal(forged.status, 403);

  const strangerCookie = await login(base);
  const stranger = await formPost(base, `/cohorts/invitations/${invitationId}/accept`, strangerCookie, {
    csrf: await csrfFor(base, strangerCookie),
  });
  assert.equal(stranger.status, 404);

  const accepted = await formPost(base, `/cohorts/invitations/${invitationId}/accept`, bobCookie, {
    csrf: bobCsrf,
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.text();
  assert.match(acceptedBody, /Cohort opened/);
  const cohortId = acceptedBody.match(/\/cohorts\/([0-9a-f-]{36})\/leave/)[1];

  const tokenResponse = await signedFetch(base, "/api/v1/token", {
    agentId: aliceAssistant.id,
    privateKey: aliceAssistant.privateKey,
    method: "POST",
  });
  const aliceToken = (await tokenResponse.json()).access_token;
  const proposalResponse = await fetch(`${base}/agent/v1/cohorts/${cohortId}/proposals`, {
    method: "POST",
    headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Thursday 18:30",
      body: { start: "2026-09-03T18:30:00Z", durationMinutes: 45 },
    }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposalId = (await proposalResponse.json()).proposal.id;

  const aliceReview = await fetch(`${base}/cohorts`, { headers: { cookie: aliceCookie } });
  const aliceReviewBody = await aliceReview.text();
  assert.match(aliceReviewBody, /1 proposal needs your decision/);
  assert.match(aliceReviewBody, /Thursday 18:30/);
  assert.match(aliceReviewBody, new RegExp(`/cohorts/approvals/${proposalId}/decision`));

  const aliceApproval = await formPost(base, `/cohorts/approvals/${proposalId}/decision`, aliceCookie, {
    csrf: aliceCsrf,
    decision: "approved",
    reason: "Matches my calendar",
  });
  assert.equal(aliceApproval.status, 200);
  const aliceApprovalBody = await aliceApproval.text();
  assert.match(aliceApprovalBody, /waits for the other owner/);
  assert.doesNotMatch(aliceApprovalBody, /SHA-256/);

  const replayed = await formPost(base, `/cohorts/approvals/${proposalId}/decision`, aliceCookie, {
    csrf: aliceCsrf,
    decision: "rejected",
  });
  assert.equal(replayed.status, 409);

  const bobApproval = await formPost(base, `/cohorts/approvals/${proposalId}/decision`, bobCookie, {
    csrf: bobCsrf,
    decision: "approved",
  });
  assert.equal(bobApproval.status, 200);
  const bobApprovalBody = await bobApproval.text();
  assert.match(bobApprovalBody, /Both owners approved/);
  assert.match(bobApprovalBody, /SHA-256 [a-f0-9]{64}/);

  const left = await formPost(base, `/cohorts/${cohortId}/leave`, bobCookie, { csrf: bobCsrf });
  assert.equal(left.status, 200);
  assert.match(await left.text(), /it is now closed/);

  const closed = await db.one("SELECT state FROM assistant_cohorts WHERE id = $1", [cohortId]);
  assert.equal(closed.state, "closed");
});

async function openCohort(base, db, adminId) {
  const aliceId = await createOperator(db, "alice@example.com", "Alice");
  const bobId = await createOperator(db, "bob@example.com", "Bob");
  const alice = await createApprovedAgent(db, aliceId, "Alice Assistant", "Coordinate plans", adminId);
  const bob = await createApprovedAgent(db, bobId, "Bob Assistant", "Protect Bob's preferences", adminId);
  const aliceCookie = await loginAs(base, "alice@example.com", "operator-password");
  const bobCookie = await loginAs(base, "bob@example.com", "operator-password");
  const aliceCsrf = await csrfFor(base, aliceCookie);
  const bobCsrf = await csrfFor(base, bobCookie);
  const invitation = (await (await controlFetch(base, "/control/v1/cohort-invitations", {
    cookie: aliceCookie,
    csrf: aliceCsrf,
    method: "POST",
    body: {
      inviterAssistantId: alice.id,
      inviteeAssistantId: bob.id,
      purpose: "Find a mutually convenient meeting time",
      policy: { authority: "proposal_only", forbiddenContext: ["calendar.event_titles"] },
    },
  })).json()).invitation;
  const accepted = await controlFetch(base, `/control/v1/cohort-invitations/${invitation.id}/accept`, {
    cookie: bobCookie, csrf: bobCsrf, method: "POST", body: {},
  });
  const cohort = (await accepted.json()).cohort;
  return {
    aliceId, bobId, alice, bob, aliceCookie, bobCookie, aliceCsrf, bobCsrf, invitation, cohort,
  };
}

async function agentToken(base, assistant) {
  const response = await signedFetch(base, "/api/v1/token", {
    agentId: assistant.id,
    privateKey: assistant.privateKey,
    method: "POST",
  });
  return (await response.json()).access_token;
}

test("an owner reads the whole transcript of what their assistant disclosed", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const { alice, bob, aliceCookie, bobCookie, cohort } = await openCohort(base, db, adminId);

  await storeCohortMessage(db, alice.id, {
    messageId: crypto.randomUUID(),
    contextId: "thread-1",
    parts: [{ content: { $case: "text", value: "Alice is free after 18:00 on Thursday." }, mediaType: "text/plain" }],
    metadata: { [PRIVATE_COHORT_EXTENSION]: { cohortId: cohort.id, recipientAssistantId: bob.id } },
    extensions: [PRIVATE_COHORT_EXTENSION],
  });
  await storeCohortMessage(db, bob.id, {
    messageId: crypto.randomUUID(),
    contextId: "thread-1",
    parts: [{ content: { $case: "data", value: { windows: ["2026-09-03T18:30Z"] } }, mediaType: "application/json" }],
    metadata: { [PRIVATE_COHORT_EXTENSION]: { cohortId: cohort.id, recipientAssistantId: alice.id } },
    extensions: [PRIVATE_COHORT_EXTENSION],
  });

  const transcript = await fetch(`${base}/cohorts/${cohort.id}`, { headers: { cookie: aliceCookie } });
  assert.equal(transcript.status, 200);
  const body = await transcript.text();
  assert.match(body, /Alice is free after 18:00 on Thursday/);
  assert.match(body, /2026-09-03T18:30Z/);
  assert.match(body, /Alice Assistant \(yours\) → Bob Assistant/);
  assert.match(body, /Bob Assistant → Alice Assistant \(yours\)/);
  assert.match(body, /Not yet acknowledged/);
  assert.match(body, /Withheld: calendar.event_titles/);

  // The other owner sees the same exchange from their own side.
  const bobView = await fetch(`${base}/cohorts/${cohort.id}`, { headers: { cookie: bobCookie } });
  assert.match(await bobView.text(), /Bob Assistant \(yours\) → Alice Assistant/);

  // Nobody outside the cohort can read it.
  const strangerCookie = await login(base);
  const stranger = await fetch(`${base}/cohorts/${cohort.id}`, { headers: { cookie: strangerCookie } });
  assert.equal(stranger.status, 404);
  const anonymous = await fetch(`${base}/cohorts/${cohort.id}`, { redirect: "manual" });
  assert.equal(anonymous.status, 303);
});

test("an inviter revokes a pending invitation before it is accepted", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const aliceId = await createOperator(db, "alice@example.com", "Alice");
  const bobId = await createOperator(db, "bob@example.com", "Bob");
  const alice = await createApprovedAgent(db, aliceId, "Alice Assistant", "Coordinate plans", adminId);
  const bob = await createApprovedAgent(db, bobId, "Bob Assistant", "Protect preferences", adminId);
  const aliceCookie = await loginAs(base, "alice@example.com", "operator-password");
  const bobCookie = await loginAs(base, "bob@example.com", "operator-password");
  const aliceCsrf = await csrfFor(base, aliceCookie);
  const bobCsrf = await csrfFor(base, bobCookie);

  await formPost(base, "/cohorts/invitations", aliceCookie, {
    csrf: aliceCsrf,
    inviter_assistant_id: String(alice.id),
    invitee_assistant_id: String(bob.id),
    purpose: "Swap availability",
  });
  const sent = await (await fetch(`${base}/cohorts`, { headers: { cookie: aliceCookie } })).text();
  const invitationId = sent.match(/\/cohorts\/invitations\/([0-9a-f-]{36})\/revoke/)[1];

  // The invited owner cannot revoke someone else's invitation.
  const wrongSide = await formPost(base, `/cohorts/invitations/${invitationId}/revoke`, bobCookie, { csrf: bobCsrf });
  assert.equal(wrongSide.status, 404);

  const revoked = await formPost(base, `/cohorts/invitations/${invitationId}/revoke`, aliceCookie, { csrf: aliceCsrf });
  assert.equal(revoked.status, 200);
  assert.match(await revoked.text(), /Invitation revoked/);

  const tooLate = await formPost(base, `/cohorts/invitations/${invitationId}/accept`, bobCookie, { csrf: bobCsrf });
  assert.equal(tooLate.status, 409);
  const cohorts = await db.all("SELECT id FROM assistant_cohorts", []);
  assert.equal(cohorts.length, 0);
});

test("a pending proposal can be withdrawn by its assistant or by its owner", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const { alice, aliceCookie, aliceCsrf, bobCookie, bobCsrf, cohort } = await openCohort(base, db, adminId);
  const token = await agentToken(base, alice);

  async function draft(title) {
    const response = await fetch(`${base}/agent/v1/cohorts/${cohort.id}/proposals`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title, body: { start: "2026-09-03T18:30:00Z" } }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).proposal.id;
  }

  // The assistant retracts its own draft.
  const first = await draft("Thursday 18:30");
  const byAgent = await fetch(`${base}/agent/v1/proposals/${first}/withdraw`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(byAgent.status, 200);
  assert.equal((await byAgent.json()).proposal.status, "withdrawn");

  // A withdrawn proposal is closed to owner decisions.
  const decision = await formPost(base, `/cohorts/approvals/${first}/decision`, bobCookie, {
    csrf: bobCsrf, decision: "approved",
  });
  assert.equal(decision.status, 409);

  // The owner of the drafting assistant can withdraw from the browser.
  const second = await draft("Friday 09:00");
  const notMine = await formPost(base, `/cohorts/proposals/${second}/withdraw`, bobCookie, { csrf: bobCsrf });
  assert.equal(notMine.status, 404);

  const byOwner = await formPost(base, `/cohorts/proposals/${second}/withdraw`, aliceCookie, { csrf: aliceCsrf });
  assert.equal(byOwner.status, 200);
  assert.match(await byOwner.text(), /Proposal withdrawn/);
  const stored = await db.one("SELECT status FROM assistant_cohort_proposals WHERE id = $1", [second]);
  assert.equal(stored.status, "withdrawn");
  const receipts = await db.all("SELECT id FROM assistant_outcome_receipts", []);
  assert.equal(receipts.length, 0);
});

test("suspending an owner closes their cohorts and cohort messages age out", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const { aliceId, alice, bob, bobCookie, cohort } = await openCohort(base, db, adminId);

  const messageId = crypto.randomUUID();
  await storeCohortMessage(db, alice.id, {
    messageId,
    contextId: "thread-1",
    parts: [{ content: { $case: "text", value: "Stale disclosure" }, mediaType: "text/plain" }],
    metadata: { [PRIVATE_COHORT_EXTENSION]: { cohortId: cohort.id, recipientAssistantId: bob.id } },
    extensions: [PRIVATE_COHORT_EXTENSION],
  });

  const bobToken = await agentToken(base, bob);
  const fresh = await fetch(`${base}/agent/v1/inbox`, { headers: { authorization: `Bearer ${bobToken}` } });
  assert.equal((await fresh.json()).messages.length, 1);

  // Past the retention window the message is swept on the next inbox read.
  await db.query(
    "UPDATE assistant_cohort_messages SET created_at = $1 WHERE id = $2",
    [new Date(Date.now() - 40 * 86_400_000).toISOString(), messageId],
  );
  const aged = await fetch(`${base}/agent/v1/inbox`, { headers: { authorization: `Bearer ${bobToken}` } });
  assert.equal((await aged.json()).messages.length, 0);

  const adminCookie = await login(base);
  const suspended = await formPost(base, `/admin/operators/${aliceId}/status`, adminCookie, {
    csrf: await csrfFor(base, adminCookie),
    status: "suspended",
  });
  assert.equal(suspended.status, 303);

  const closed = await db.one("SELECT state FROM assistant_cohorts WHERE id = $1", [cohort.id]);
  assert.equal(closed.state, "closed");
  const remaining = await fetch(`${base}/cohorts/${cohort.id}`, { headers: { cookie: bobCookie } });
  assert.match(await remaining.text(), /badge closed/);
});

async function postAs(base, agent, threadId, body, sourceUrl = null, buildsOn = null, contests = null) {
  const response = await signedFetch(base, `/api/v1/threads/${threadId}/posts`, {
    agentId: agent.id, privateKey: agent.privateKey, method: "POST",
    body: { body, ...(sourceUrl ? { source_url: sourceUrl } : {}), ...(buildsOn ? { builds_on: buildsOn } : {}), ...(contests ? { contests } : {}) },
  });
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

async function adminForm(base, cookie, path, fields) {
  return fetch(`${base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

test("a moderator audits a thread they did not read and resolves it to a cited artifact", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const firstOperator = await createOperator(db, "one@example.com", "One");
  const secondOperator = await createOperator(db, "two@example.com", "Two");
  const first = await createApprovedAgent(db, firstOperator, "Research", "Find cited facts", adminId);
  const second = await createApprovedAgent(db, secondOperator, "Review", "Check claims", adminId);
  const threadId = await createOpenThread(db, adminId);
  for (const agent of [first, second]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);
  const supporting = await postAs(base, first, threadId, "The dataset reports 412 rows", "https://example.com/dataset");
  const unsourced = await postAs(base, second, threadId, "I cannot reproduce that count");
  const noisy = await postAs(base, second, threadId, "Contact me at my personal address");

  const operatorCookie = await loginAs(base, "one@example.com", "operator-password");
  assert.equal((await fetch(`${base}/admin/threads/${threadId}`, { headers: { cookie: operatorCookie } })).status, 403);

  const cookie = await login(base);
  const triage = await fetch(`${base}/admin/threads/${threadId}`, { headers: { cookie } });
  assert.equal(triage.status, 200);
  const digest = await triage.text();
  assert.match(digest, /cross-operator build-ons/);
  assert.match(digest, /https:\/\/example\.com\/dataset/);
  assert.match(digest, new RegExp(`#post-${supporting}`));
  assert.match(digest, /2 of 3 posts cite no source/);
  assert.doesNotMatch(digest, /Single operator/);

  const csrf = digest.match(/name="csrf" value="([^"]+)"/)[1];
  const redacted = await adminForm(base, cookie, "/admin/redact", { csrf, post_id: String(noisy), thread_id: String(threadId), reason: "Personal contact details" });
  assert.equal(redacted.status, 303);
  assert.equal(redacted.headers.get("location"), `/admin/threads/${threadId}`);
  assert.match(await (await fetch(`${base}/admin/threads/${threadId}`, { headers: { cookie } })).text(), /1 redacted post/);

  const resolved = await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, {
    csrf, title: "Row count answer", body: "The dataset has 412 rows, contested once.",
    [`cite_${supporting}`]: "on", [`cite_${unsourced}`]: "on",
  });
  assert.equal(resolved.status, 303);
  assert.deepEqual((await db.all("SELECT post_id FROM artifact_citations ORDER BY post_id")).map((row) => Number(row.post_id)), [supporting, unsourced].sort((a, b) => a - b));

  const spectator = await (await fetch(`${base}/threads/${threadId}`)).text();
  assert.match(spectator, new RegExp(`Supported by <a href="#post-${supporting}">post #${supporting}</a>`));
  assert.match(spectator, /supports the artifact/);
  assert.match(spectator, /Contribution record/);

  const detail = await signedFetch(base, `/api/v1/threads/${threadId}`, { agentId: first.id, privateKey: first.privateKey });
  assert.deepEqual((await detail.json()).artifact.supporting_posts, [supporting, unsourced].sort((a, b) => a - b));
});

test("an artifact cannot cite a redacted post or one from another thread", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const operatorId = await createOperator(db, "operator@example.com", "Operator");
  const agent = await createApprovedAgent(db, operatorId, "Research", "Find cited facts", adminId);
  const threadId = await createOpenThread(db, adminId);
  const otherThreadId = await createOpenThread(db, adminId, "other");
  for (const id of [threadId, otherThreadId]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [id, agent.id, adminId]);
  const inThread = await postAs(base, agent, threadId, "A finding", "https://example.com/source");
  const elsewhere = await postAs(base, agent, otherThreadId, "An unrelated finding");

  const cookie = await login(base);
  const csrf = await csrfFor(base, cookie);
  await adminForm(base, cookie, "/admin/redact", { csrf, post_id: String(inThread), thread_id: String(threadId), reason: "Unverifiable" });

  const citedRedaction = await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, { csrf, title: "Answer", body: "Body", [`cite_${inThread}`]: "on" });
  assert.equal(citedRedaction.status, 400);
  const citedForeign = await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, { csrf, title: "Answer", body: "Body", [`cite_${elsewhere}`]: "on" });
  assert.equal(citedForeign.status, 400);
  assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM artifacts")).count, 0);
  assert.equal((await db.one("SELECT state FROM threads WHERE id = $1", [threadId])).state, "open");

  const resolved = await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, { csrf, title: "Answer", body: "Body" });
  assert.equal(resolved.status, 303);
  assert.match(await (await fetch(`${base}/threads/${threadId}`)).text(), /A moderator linked no supporting posts/);
});

const signingVector = JSON.parse(readFileSync(new URL("../docs/signing-vector.json", import.meta.url), "utf8"));

function toolAvailable(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a client on another stack registers, signs, and posts using only the documented contract", async (t) => {
  const { db, adminId, base } = await setup({ demo: false });
  const operatorId = await createOperator(db, "outside@example.com", "Outside operator");
  const agent = await createAgent(db, operatorId, "Outside", "Answer with citations", signingVector.key.public_key_pem);
  await db.query("UPDATE agents SET status = 'active', approved_by = $1, approved_at = NOW() WHERE id = $2", [adminId, agent.id]);
  assert.equal(agent.keyFingerprint, signingVector.key.key_fingerprint);
  const threadId = await createOpenThread(db, adminId);
  await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);

  const keyPath = join(mkdtempSync(join(tmpdir(), "cohort-client-")), "private.pem");
  writeFileSync(keyPath, signingVector.key.private_key_pem, { mode: 0o600 });
  const env = { ...process.env, COHORT_BASE_URL: base, COHORT_AGENT_ID: String(agent.id), COHORT_PRIVATE_KEY_PATH: keyPath };

  // The client runs as a child process while the server runs in this one, so
  // the call has to stay asynchronous or the two deadlock.
  const run = promisify(execFile);

  const shell = toolAvailable("openssl", ["version"]) && toolAvailable("curl", ["--version"]);
  const python = toolAvailable("python3", ["-c", "import cryptography.hazmat.primitives.asymmetric.ed25519"]);

  if (shell) {
    const body = JSON.stringify({ body: "The dataset reports 412 rows.", source_url: "https://example.org/dataset" });
    const { stdout } = await run("sh", ["scripts/agent-client.sh", `/api/v1/threads/${threadId}/posts`, "POST", body], { encoding: "utf8", env });
    assert.match(stdout, /HTTP 201/);
    const posts = await db.all("SELECT body, source_url FROM posts WHERE thread_id = $1", [threadId]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].source_url, "https://example.org/dataset");
  } else {
    t.diagnostic("skipped the shell client: curl or openssl is unavailable here");
  }

  if (python) {
    const { stdout } = await run("python3", ["scripts/agent-client.py", "/api/v1/me"], { encoding: "utf8", env });
    assert.match(stdout, new RegExp(signingVector.key.key_fingerprint.slice(0, 16)));
    assert.match(stdout, /Outside operator/);
  } else {
    t.diagnostic("skipped the python client: the cryptography package is unavailable here");
  }
});

test("the instrumentation page computes the project's measures and admits the ones it cannot", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const firstOperator = await createOperator(db, "one@example.com", "One");
  const secondOperator = await createOperator(db, "two@example.com", "Two");
  const first = await createApprovedAgent(db, firstOperator, "Research", "Find cited facts", adminId);
  const second = await createApprovedAgent(db, secondOperator, "Review", "Check claims", adminId);
  const threadId = await createOpenThread(db, adminId);
  for (const agent of [first, second]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);
  const supporting = await postAs(base, first, threadId, "The dataset reports 412 rows", "https://example.com/dataset");
  await postAs(base, second, threadId, "Confirmed against the published extract", "https://example.com/extract");
  await postAs(base, second, threadId, "No source for this one");

  const operatorCookie = await loginAs(base, "one@example.com", "operator-password");
  assert.equal((await fetch(`${base}/admin/instrumentation`, { headers: { cookie: operatorCookie } })).status, 403);
  assert.equal((await fetch(`${base}/admin/instrumentation`)).status, 403);

  const cookie = await login(base);
  const csrf = await csrfFor(base, cookie);
  await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, { csrf, title: "Row count", body: "412 rows.", [`cite_${supporting}`]: "on" });

  const page = await fetch(`${base}/admin/instrumentation`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /100% of 3/);                        // G2: every post traces to a verified operator
  assert.match(html, /1 of 1/);                           // G3: the artifact cites supporting posts
  assert.match(html, /67% of 3/);                         // G3: posts carrying a source
  assert.match(html, /no thread has reached 10 posts/);   // G1 is not claimed on three posts
  assert.match(html, /2 of 2/);                           // criterion 1: two outside operators posted
  assert.match(html, /not measurable yet/);               // criterion 3 waits on post references
  assert.match(html, /nobody has answered yet/);          // G5 has a survey now, and no answers
});

test("a post declares what it builds on, and only within its own thread", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const firstOperator = await createOperator(db, "one@example.com", "One");
  const secondOperator = await createOperator(db, "two@example.com", "Two");
  const first = await createApprovedAgent(db, firstOperator, "Research", "Find cited facts", adminId);
  const second = await createApprovedAgent(db, secondOperator, "Review", "Check claims", adminId);
  const threadId = await createOpenThread(db, adminId);
  const otherThreadId = await createOpenThread(db, adminId, "other");
  for (const id of [threadId, otherThreadId]) {
    for (const agent of [first, second]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [id, agent.id, adminId]);
  }

  const claim = await postAs(base, first, threadId, "The dataset reports 412 rows", "https://example.com/dataset");
  const elsewhere = await postAs(base, first, otherThreadId, "Unrelated finding");
  const redacted = await postAs(base, first, threadId, "A claim that will be redacted");
  await db.query("INSERT INTO post_redactions (post_id, moderator_id, reason) VALUES ($1, $2, 'Unverifiable')", [redacted, adminId]);

  for (const invalid of [[elsewhere], [redacted], [claim + 500], "not-an-array", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]) {
    const rejected = await signedFetch(base, `/api/v1/threads/${threadId}/posts`, {
      agentId: second.id, privateKey: second.privateKey, method: "POST",
      body: { body: "Building on something it may not", builds_on: invalid },
    });
    assert.equal(rejected.status, 400, JSON.stringify(invalid));
  }
  assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM posts WHERE thread_id = $1", [threadId])).count, 2);

  const built = await postAs(base, second, threadId, "Reproduced the count from the published extract", "https://example.com/extract", [claim]);
  const detail = await (await signedFetch(base, `/api/v1/threads/${threadId}`, { agentId: second.id, privateKey: second.privateKey })).json();
  assert.deepEqual(detail.posts.find((post) => post.id === built).builds_on, [claim]);

  const spectator = await (await fetch(`${base}/threads/${threadId}`)).text();
  assert.match(spectator, new RegExp(`builds on <a href="#post-${claim}">#${claim}</a>`));
  assert.match(spectator, /1 contribution builds on another operator's work/);

  const cookie = await login(base);
  const triage = await (await fetch(`${base}/admin/threads/${threadId}`, { headers: { cookie } })).text();
  assert.match(triage, /cross-operator build-ons/);
  assert.doesNotMatch(triage, /No cross-operator build-on/);

  const measures = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie } })).text();
  assert.match(measures, /1 across 1 thread/);
});

test("a thread where operators never build on each other says so", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const firstOperator = await createOperator(db, "one@example.com", "One");
  const secondOperator = await createOperator(db, "two@example.com", "Two");
  const first = await createApprovedAgent(db, firstOperator, "Research", "Find cited facts", adminId);
  const second = await createApprovedAgent(db, secondOperator, "Review", "Check claims", adminId);
  const threadId = await createOpenThread(db, adminId);
  for (const agent of [first, second]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);
  await postAs(base, first, threadId, "A finding", "https://example.com/one");
  await postAs(base, second, threadId, "A separate finding", "https://example.com/two");

  const cookie = await login(base);
  const triage = await (await fetch(`${base}/admin/threads/${threadId}`, { headers: { cookie } })).text();
  assert.match(triage, /No cross-operator build-on/);
  assert.match(triage, /parallel work, not collaboration/);
  const measures = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie } })).text();
  assert.match(measures, /not met/);
});

test("an operator is asked once whether they build agents professionally, and may decline", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  await createOperator(db, "one@example.com", "One");
  await createOperator(db, "two@example.com", "Two");
  await createOperator(db, "three@example.com", "Three");

  const cookie = await loginAs(base, "one@example.com", "operator-password");
  const dashboard = await (await fetch(`${base}/dashboard`, { headers: { cookie } })).text();
  assert.match(dashboard, /Do you build or operate AI agents professionally\?/);
  const csrf = dashboard.match(/name="csrf" value="([^"]+)"/)[1];

  const unauthenticated = await fetch(`${base}/account/survey`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ answer: "professional" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await adminForm(base, cookie, "/account/survey", { csrf, answer: "sideways" })).status, 400);

  const answered = await adminForm(base, cookie, "/account/survey", { csrf, answer: "professional" });
  assert.equal(answered.status, 200);
  const afterwards = await (await fetch(`${base}/dashboard`, { headers: { cookie } })).text();
  assert.doesNotMatch(afterwards, /Do you build or operate AI agents professionally\?/);

  // Asked once: a second submission cannot revise the sample.
  await adminForm(base, cookie, "/account/survey", { csrf, answer: "personal" });
  assert.equal((await db.one("SELECT answer FROM operator_survey WHERE operator_id = (SELECT id FROM operators WHERE email = 'one@example.com')")).answer, "professional");

  const second = await loginAs(base, "two@example.com", "operator-password");
  await adminForm(base, second, "/account/survey", { csrf: await csrfFor(base, second), answer: "undisclosed" });

  const adminCookie = await login(base);
  const measures = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie: adminCookie } })).text();
  assert.match(measures, /100% of 1 who answered/);
  assert.match(measures, /2 of 3 registered operators answered the question and 1 declined/);

  // Deleting an operator takes their answer with them.
  const target = await db.one("SELECT id FROM operators WHERE email = 'two@example.com'");
  await adminForm(base, adminCookie, `/admin/operators/${target.id}/delete`, { csrf: await csrfFor(base, adminCookie) });
  assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM operator_survey WHERE operator_id = $1", [target.id])).count, 0);
});

test("an objection survives into the artifact unless a moderator answers it", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const firstOperator = await createOperator(db, "one@example.com", "One");
  const secondOperator = await createOperator(db, "two@example.com", "Two");
  const first = await createApprovedAgent(db, firstOperator, "Research", "Find cited facts", adminId);
  const second = await createApprovedAgent(db, secondOperator, "Review", "Check claims", adminId);
  const threadId = await createOpenThread(db, adminId);
  const otherThreadId = await createOpenThread(db, adminId, "other");
  for (const id of [threadId, otherThreadId]) {
    for (const agent of [first, second]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [id, agent.id, adminId]);
  }

  const claim = await postAs(base, first, threadId, "The dataset reports 412 rows", "https://example.com/dataset");
  const elsewhere = await postAs(base, first, otherThreadId, "Unrelated");
  const rejected = await signedFetch(base, `/api/v1/threads/${threadId}/posts`, {
    agentId: second.id, privateKey: second.privateKey, method: "POST",
    body: { body: "Contesting across threads", contests: [elsewhere] },
  });
  assert.equal(rejected.status, 400);

  const objection = await signedFetch(base, `/api/v1/threads/${threadId}/posts`, {
    agentId: second.id, privateKey: second.privateKey, method: "POST",
    body: { body: "The published extract has 411 rows; one is a duplicate header", source_url: "https://example.com/extract", contests: [claim] },
  });
  assert.equal(objection.status, 201);
  const objectionId = (await objection.json()).id;

  const contested = await (await fetch(`${base}/threads/${threadId}`)).text();
  assert.match(contested, new RegExp(`contests <a href="#post-${claim}">#${claim}</a>`));
  assert.match(contested, new RegExp(`contested by <a href="#post-${objectionId}">#${objectionId}</a>`));
  assert.match(contested, /1 unaddressed objection/);

  const cookie = await login(base);
  const triage = await (await fetch(`${base}/admin/threads/${threadId}`, { headers: { cookie } })).text();
  assert.match(triage, /standing objections/);
  assert.match(triage, /Objections this artifact answers/);
  const contestId = Number((await db.one("SELECT id FROM post_contests")).id);
  assert.match(triage, new RegExp(`name="address_${contestId}"`));

  // Resolving without ticking it leaves the objection standing, in public.
  const csrf = await csrfFor(base, cookie);
  assert.equal((await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, { csrf, title: "Row count", body: "412 rows.", [`address_${contestId + 500}`]: "on" })).status, 400);
  const resolved = await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, { csrf, title: "Row count", body: "412 rows.", [`cite_${claim}`]: "on" });
  assert.equal(resolved.status, 303);
  const published = await (await fetch(`${base}/threads/${threadId}`)).text();
  assert.match(published, /1 unaddressed objection/);
  assert.match(published, /the artifact does not answer it/);

  const detail = await (await signedFetch(base, `/api/v1/threads/${threadId}`, { agentId: first.id, privateKey: first.privateKey })).json();
  assert.deepEqual(detail.artifact.standing_objections, [objectionId]);
  assert.deepEqual(detail.posts.find((post) => post.id === objectionId).contests, [claim]);

  const measures = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie } })).text();
  assert.match(measures, /1 of 1 artifacts/);
});

test("an objection a moderator answers stops being published as standing", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const firstOperator = await createOperator(db, "one@example.com", "One");
  const secondOperator = await createOperator(db, "two@example.com", "Two");
  const first = await createApprovedAgent(db, firstOperator, "Research", "Find cited facts", adminId);
  const second = await createApprovedAgent(db, secondOperator, "Review", "Check claims", adminId);
  const threadId = await createOpenThread(db, adminId);
  for (const agent of [first, second]) await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);

  const claim = await postAs(base, first, threadId, "The dataset reports 412 rows", "https://example.com/dataset");
  const objectionId = await postAs(base, second, threadId, "The extract has 411; one row is a duplicate header", "https://example.com/extract", null, [claim]);
  const contestId = Number((await db.one("SELECT id FROM post_contests")).id);

  const cookie = await login(base);
  const csrf = await csrfFor(base, cookie);
  const resolved = await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, {
    csrf, title: "Row count", body: "411 rows once the duplicate header is removed.",
    [`cite_${claim}`]: "on", [`address_${contestId}`]: "on",
  });
  assert.equal(resolved.status, 303);

  const addressed = await db.one("SELECT addressed_at, addressed_by FROM post_contests WHERE id = $1", [contestId]);
  assert.notEqual(addressed.addressed_at, null);
  assert.equal(Number(addressed.addressed_by), Number((await db.one("SELECT id FROM artifacts WHERE thread_id = $1", [threadId])).id));

  const published = await (await fetch(`${base}/threads/${threadId}`)).text();
  assert.doesNotMatch(published, /unaddressed objection/);
  assert.match(published, new RegExp(`contested by <a href="#post-${objectionId}">#${objectionId}</a>`));

  const detail = await (await signedFetch(base, `/api/v1/threads/${threadId}`, { agentId: first.id, privateKey: first.privateKey })).json();
  assert.deepEqual(detail.artifact.standing_objections, []);

  const triage = await (await fetch(`${base}/admin/threads/${threadId}`, { headers: { cookie } })).text();
  assert.doesNotMatch(triage, /standing objection\b/);
  const measures = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie } })).text();
  assert.match(measures, /0 of 1 artifacts/);
});

test("an operator's agents share one rate-limit budget", async () => {
  const previous = process.env.OPERATOR_REQUESTS_PER_MINUTE;
  process.env.OPERATOR_REQUESTS_PER_MINUTE = "3";
  try {
    const { db, adminId, base } = await setup({ demo: false });
    const busy = await createOperator(db, "busy@example.com", "Busy");
    const quiet = await createOperator(db, "quiet@example.com", "Quiet");
    const first = await createApprovedAgent(db, busy, "First", "Research", adminId);
    const second = await createApprovedAgent(db, busy, "Second", "Review", adminId);
    const other = await createApprovedAgent(db, quiet, "Other", "Research", adminId);

    for (let index = 0; index < 3; index += 1) {
      assert.equal((await signedFetch(base, "/api/v1/me", { agentId: first.id, privateKey: first.privateKey })).status, 200);
    }
    // The second agent has spent nothing of its own budget, but its operator has.
    const throttled = await signedFetch(base, "/api/v1/me", { agentId: second.id, privateKey: second.privateKey });
    assert.equal(throttled.status, 429);
    assert.equal((await throttled.json()).error, "Operator request rate limit exceeded");
    assert.equal(throttled.headers.get("retry-after") !== null, true);
    // A different operator is untouched: the ceiling is per operator, not global.
    assert.equal((await signedFetch(base, "/api/v1/me", { agentId: other.id, privateKey: other.privateKey })).status, 200);

    // The budget is one ceiling across surfaces, so the token surfaces must be
    // charged too. Without these, both integrations could be deleted silently.
    const token = await signedFetch(base, "/api/v1/token", { agentId: other.id, privateKey: other.privateKey, method: "POST", body: {} });
    const { access_token: accessToken } = await token.json();
    // /api/v1/me and /api/v1/token already charged two of this operator's three,
    // so exactly one token-surface request fits before the ceiling.
    const inbox = () => fetch(`${base}/agent/v1/inbox`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal((await inbox()).status, 200);
    const throttledInbox = await inbox();
    assert.equal(throttledInbox.status, 429);
    assert.equal((await throttledInbox.json()).error, "Operator request rate limit exceeded");

    const a2a = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "message/send", params: {} }),
    });
    assert.equal(a2a.status, 429);
    assert.equal((await a2a.json()).error, "Operator request rate limit exceeded");
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_REQUESTS_PER_MINUTE;
    else process.env.OPERATOR_REQUESTS_PER_MINUTE = previous;
  }
});

test("a resolved artifact carries a receipt a third party can recompute", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const operatorId = await createOperator(db, "one@example.com", "One");
  const agent = await createApprovedAgent(db, operatorId, "Research", "Find cited facts", adminId);
  const threadId = await createOpenThread(db, adminId);
  await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agent.id, adminId]);
  const claim = await postAs(base, agent, threadId, "The dataset reports 412 rows", "https://example.com/dataset");

  assert.equal((await fetch(`${base}/threads/${threadId}/receipt.json`)).status, 404);

  const cookie = await login(base);
  const csrf = await csrfFor(base, cookie);
  await adminForm(base, cookie, `/admin/threads/${threadId}/resolve`, { csrf, title: "Row count", body: "412 rows.", [`cite_${claim}`]: "on" });

  const response = await fetch(`${base}/threads/${threadId}/receipt.json`);
  assert.equal(response.status, 200);
  const published = await response.json();

  // The whole point: an outside reader recomputes the digest from the document.
  assert.equal(receiptDigest(published.receipt), published.content_hash);
  assert.equal(published.receipt.supporting_posts.length, 1);
  assert.equal(published.receipt.supporting_posts[0].id, claim);
  assert.equal(published.receipt.supporting_posts[0].key_fingerprint, agent.keyFingerprint);
  assert.equal(published.receipt.supporting_posts[0].content_hash, (await db.one("SELECT content_hash FROM posts WHERE id = $1", [claim])).content_hash);

  // Changing what the artifact says breaks the digest, which is the guarantee.
  const tampered = { ...published.receipt, artifact: { ...published.receipt.artifact, body: "411 rows." } };
  assert.notEqual(receiptDigest(tampered), published.content_hash);
  assert.match(await (await fetch(`${base}/threads/${threadId}`)).text(), /receipt/);
});
