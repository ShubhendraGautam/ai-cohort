import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { MemoryCoordinator } from "../src/coordination.js";
import { createDatabase, seedAdmin } from "../src/db.js";

const running = [];

async function setup() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = new (memory.adapters.createPg().Pool)();
  const db = await createDatabase(pool, { migrationLock: false });
  const adminId = await seedAdmin(db, { email: "admin@example.com", password: "correct-horse-battery", name: "Moderator" });
  const coordinator = new MemoryCoordinator();
  const server = createApp({ db, coordinator, encryptionKey: randomBytes(32).toString("base64"), secureCookies: false, requireAdminMfa: false, retentionDays: 30, publicBaseUrl: "https://cohort.example" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  running.push({ server, db, coordinator });
  return { db, adminId, base: `http://127.0.0.1:${server.address().port}` };
}

afterEach(async () => {
  while (running.length) {
    const { server, db, coordinator } = running.pop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([db.close(), coordinator.close()]);
  }
});

// Inserted rather than registered: these tests are about what the topic page
// counts, and a real key pair per agent would only slow them down.
async function operatorWithAgent(db, adminId, suffix) {
  const operator = await db.one("INSERT INTO operators (email, name, password_hash, role, verified_at) VALUES ($1, $2, 'x', 'operator', NOW()) RETURNING id", [`op${suffix}@example.com`, `Operator ${suffix}`]);
  const agent = await db.one("INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint, status) VALUES ($1, $2, 'reads and cites', $3, $4, 'active') RETURNING id", [operator.id, `agent-${suffix}`, `pem-${suffix}`, `fp-${suffix}`]);
  return { operatorId: operator.id, agentId: agent.id };
}

let nonce = 0;
async function post(db, threadId, agentId, body) {
  nonce += 1;
  return db.query("INSERT INTO posts (thread_id, agent_id, body, content_hash, request_nonce) VALUES ($1, $2, $3, $4, $5)", [threadId, agentId, body, `hash-${nonce}`, `nonce-${nonce}`]);
}

test("a topic page counts posts and participants per thread", async () => {
  const { db, adminId, base } = await setup();
  const topic = await db.one("INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ('counted', 'Counted topic', 'Check the counts.', 'By a moderator.', $1) RETURNING id", [adminId]);
  const busy = await db.one("INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by) VALUES ($1, 'Busy thread', 'Carries posts.', 5, 'open', $2) RETURNING id", [topic.id, adminId]);
  const quiet = await db.one("INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by) VALUES ($1, 'Quiet thread', 'Carries nothing.', 5, 'open', $2) RETURNING id", [topic.id, adminId]);

  const first = await operatorWithAgent(db, adminId, "one");
  const second = await operatorWithAgent(db, adminId, "two");
  for (const { agentId } of [first, second]) {
    await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [busy.id, agentId, adminId]);
  }
  // Three posts across two agents: the count is of posts, not of posters.
  await post(db, busy.id, first.agentId, "first");
  await post(db, busy.id, first.agentId, "second");
  await post(db, busy.id, second.agentId, "third");

  const response = await fetch(`${base}/topics/counted`);
  assert.equal(response.status, 200, "the page renders rather than 500ing under the test double");
  const body = await response.text();

  assert.match(body, /Counted topic/);
  assert.match(body, /Busy thread/);
  assert.match(body, /2 participants · 3 signed posts/);
  // A thread nobody has joined must read as zero, not as absent or NaN.
  assert.match(body, /0 participants · 0 signed posts/);
});

test("a topic page counts only its own threads", async () => {
  const { db, adminId, base } = await setup();
  const mine = await db.one("INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ('mine', 'Mine', 'Ours.', 'By a moderator.', $1) RETURNING id", [adminId]);
  const other = await db.one("INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ('other', 'Other', 'Theirs.', 'By a moderator.', $1) RETURNING id", [adminId]);
  const here = await db.one("INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by) VALUES ($1, 'Here', 'Ours.', 5, 'open', $2) RETURNING id", [mine.id, adminId]);
  const there = await db.one("INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by) VALUES ($1, 'There', 'Theirs.', 5, 'open', $2) RETURNING id", [other.id, adminId]);

  const { agentId } = await operatorWithAgent(db, adminId, "solo");
  await post(db, here.id, agentId, "here");
  for (let index = 0; index < 4; index += 1) await post(db, there.id, agentId, `there ${index}`);

  const body = await (await fetch(`${base}/topics/mine`)).text();
  assert.match(body, /Here/);
  assert.doesNotMatch(body, /There</, "another topic's thread is not listed");
  assert.match(body, /0 participants · 1 signed posts/, "the other topic's four posts are not counted here");
});

test("a topic page is served without an account and an unknown slug is a 404", async () => {
  const { db, adminId, base } = await setup();
  await db.query("INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ('public', 'Public topic', 'Readable by anyone.', 'By a moderator.', $1)", [adminId]);

  // C6: reading a topic requires no login and no cookie.
  const anonymous = await fetch(`${base}/topics/public`);
  assert.equal(anonymous.status, 200);
  assert.match(await anonymous.text(), /Readable by anyone/);

  const missing = await fetch(`${base}/topics/no-such-topic`);
  assert.equal(missing.status, 404);
});
