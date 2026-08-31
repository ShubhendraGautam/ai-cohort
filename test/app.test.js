import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createAgent, now, openDatabase, pruneExpired, seedAdmin, seedDemo } from "../src/db.js";

const running = [];

async function setup({ demo = true } = {}) {
  const db = openDatabase(":memory:");
  const adminId = seedAdmin(db, { email: "admin@example.com", password: "correct-horse-battery", name: "Moderator" });
  if (demo) seedDemo(db, adminId);
  const server = createApp({ db, secureCookies: false, retentionDays: 30 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  running.push({ server, db });
  return { db, adminId, base };
}

afterEach(async () => {
  while (running.length) {
    const { server, db } = running.pop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

async function login(base) {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@example.com", password: "correct-horse-battery" }),
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

test("public spectator pages expose topics and resolved artifacts", async () => {
  const { base } = await setup();
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Welcome to AI Cohort/);

  const thread = await fetch(`${base}/threads/1`);
  assert.equal(thread.status, 200);
  const html = await thread.text();
  assert.match(html, /Resolved artifact/);
  assert.match(html, /First-cohort operating agreement/);
});

test("moderator login is protected by CSRF for state-changing forms", async () => {
  const { base } = await setup();
  const cookie = await login(base);
  const admin = await fetch(`${base}/admin`, { headers: { cookie } });
  const html = await admin.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];

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
  assert.equal(created.headers.get("location"), "/admin");
});

test("admitted agents can post and frozen threads reject new posts", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const timestamp = now();
  const operatorId = Number(db.prepare(`INSERT INTO operators (email, name, password_hash, verified_at, created_at) VALUES (?, ?, ?, ?, ?)`).run("operator@example.com", "Operator", hashPassword("operator-password"), timestamp, timestamp).lastInsertRowid);
  const agent = createAgent(db, operatorId, "Research agent", "Find cited facts");
  const topicId = Number(db.prepare(`INSERT INTO topics (slug, title, objective, admission_rules, created_by, created_at) VALUES ('data', 'Data', 'Answer questions', 'Invite', ?, ?)`).run(adminId, timestamp).lastInsertRowid);
  const threadId = Number(db.prepare(`INSERT INTO threads (topic_id, title, objective, participant_cap, created_by, created_at, updated_at) VALUES (?, 'Question', 'Answer it', 3, ?, ?, ?)`).run(topicId, adminId, timestamp, timestamp).lastInsertRowid);
  db.prepare("INSERT INTO thread_participants (thread_id, agent_id, admitted_by, admitted_at) VALUES (?, ?, ?, ?)").run(threadId, agent.id, adminId, timestamp);

  const posted = await fetch(`${base}/api/v1/threads/${threadId}/posts`, {
    method: "POST",
    headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: "A cited finding", source_url: "https://example.com/source" }),
  });
  assert.equal(posted.status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts").get().count, 1);

  db.prepare("UPDATE threads SET state = 'frozen' WHERE id = ?").run(threadId);
  const frozen = await fetch(`${base}/api/v1/threads/${threadId}/posts`, {
    method: "POST",
    headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: "Should fail" }),
  });
  assert.equal(frozen.status, 409);
});

test("direct channels require a shared thread and honor message retention", async () => {
  const { db, adminId, base } = await setup({ demo: false });
  const timestamp = now();
  const operatorId = Number(db.prepare(`INSERT INTO operators (email, name, password_hash, verified_at, created_at) VALUES (?, ?, ?, ?, ?)`).run("one@example.com", "One", hashPassword("operator-password"), timestamp, timestamp).lastInsertRowid);
  const otherOperatorId = Number(db.prepare(`INSERT INTO operators (email, name, password_hash, verified_at, created_at) VALUES (?, ?, ?, ?, ?)`).run("two@example.com", "Two", hashPassword("operator-password"), timestamp, timestamp).lastInsertRowid);
  const first = createAgent(db, operatorId, "First", "Research");
  const second = createAgent(db, otherOperatorId, "Second", "Review");

  const denied = await fetch(`${base}/api/v1/direct-channels`, { method: "POST", headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" }, body: JSON.stringify({ agent_id: second.id }) });
  assert.equal(denied.status, 403);

  const topicId = Number(db.prepare(`INSERT INTO topics (slug, title, objective, admission_rules, created_by, created_at) VALUES ('shared', 'Shared', 'Work', 'Invite', ?, ?)`).run(adminId, timestamp).lastInsertRowid);
  const threadId = Number(db.prepare(`INSERT INTO threads (topic_id, title, objective, participant_cap, created_by, created_at, updated_at) VALUES (?, 'Shared work', 'Work', 3, ?, ?, ?)`).run(topicId, adminId, timestamp, timestamp).lastInsertRowid);
  for (const agent of [first, second]) db.prepare("INSERT INTO thread_participants (thread_id, agent_id, admitted_by, admitted_at) VALUES (?, ?, ?, ?)").run(threadId, agent.id, adminId, timestamp);

  const opened = await fetch(`${base}/api/v1/direct-channels`, { method: "POST", headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" }, body: JSON.stringify({ agent_id: second.id }) });
  assert.equal(opened.status, 201);
  const channel = await opened.json();
  const message = await fetch(`${base}/api/v1/direct-channels/${channel.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" }, body: JSON.stringify({ body: "Check this sub-question" }) });
  assert.equal(message.status, 201);

  db.prepare("UPDATE direct_messages SET created_at = '2020-01-01T00:00:00.000Z'").run();
  assert.equal(pruneExpired(db, 30), 1);
});
