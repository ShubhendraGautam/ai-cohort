import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { MemoryCoordinator } from "../src/coordination.js";
import { createDatabase, seedAdmin, seedTriageFixture, TRIAGE_FIXTURE_POSTS } from "../src/db.js";
import { threadAudit } from "../src/threads/audit.js";

const running = [];
const ADMIN = { email: "admin@example.com", password: "correct-horse-battery", name: "Moderator" };

async function setup() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = new (memory.adapters.createPg().Pool)();
  const db = await createDatabase(pool, { migrationLock: false });
  const adminId = await seedAdmin(db, ADMIN);
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

async function login(base) {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: ADMIN.email, password: ADMIN.password }),
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

test("the fixture builds the thread G3's measure is stated against", async () => {
  const { db, adminId } = await setup();
  const result = await seedTriageFixture(db, adminId);

  assert.equal(result.created, true);
  assert.equal(result.postIds.length, TRIAGE_FIXTURE_POSTS);
  assert.equal(TRIAGE_FIXTURE_POSTS, 100, "G3 measures a 100-post thread; a smaller fixture cannot take that measurement");

  const audit = await threadAudit(db, result.threadId);
  assert.equal(audit.totals.posts, 100);
  assert.ok(audit.agents.length >= 3, "more than one agent contributed");
  assert.ok(audit.totals.operators >= 3, "more than one operator contributed");
  assert.ok(audit.totals.crossOperatorBuildOns > 0, "contributions build on another operator's work");
  assert.equal(audit.totals.redactions, 1, "a redaction is present so triage shows a tombstone");

  // Asserted exactly, not with >=. codex found the fixture describing an
  // answered objection it never addressed, and a loose assertion is what let
  // the description drift from the rows.
  const contests = await db.all("SELECT addressed_at, addressed_by FROM post_contests");
  assert.equal(contests.length, 2, "two contributions contest another");
  assert.equal(contests.filter((row) => row.addressed_at).length, 0, "neither is addressed");
  assert.equal(audit.standingObjections.length, 2, "both objections stand in the triage view");
  assert.equal(await db.maybeOne("SELECT id FROM artifacts WHERE thread_id = $1", [result.threadId]), null,
    "the thread is deliberately unresolved: a moderator triages what still needs a decision");
});

test("the fixture refuses a post count below the measure it exists to serve", async () => {
  const { db, adminId } = await setup();

  await assert.rejects(
    () => seedTriageFixture(db, adminId, { posts: 99 }),
    /at least 100 posts/,
    "a smaller fixture would look like one while leaving G3's measure untakeable",
  );
  assert.equal((await db.all("SELECT id FROM posts")).length, 0, "the refused run wrote nothing");

  const larger = await seedTriageFixture(db, adminId, { posts: 101 });
  assert.equal(larger.postIds.length, 101, "a larger thread is allowed; only smaller is not");
});

test("the same seed reproduces the same thread and a different seed does not", async () => {
  const first = await setup();
  const a = await seedTriageFixture(first.db, first.adminId, { seed: 4242 });
  const bodiesA = (await first.db.all("SELECT body FROM posts ORDER BY id")).map((row) => row.body);

  const second = await setup();
  const b = await seedTriageFixture(second.db, second.adminId, { seed: 4242 });
  const bodiesB = (await second.db.all("SELECT body FROM posts ORDER BY id")).map((row) => row.body);

  assert.deepEqual(bodiesA, bodiesB, "a fixed seed reproduces the thread exactly");
  assert.equal(a.crossOperator, b.crossOperator);

  const third = await setup();
  await seedTriageFixture(third.db, third.adminId, { seed: 99 });
  const bodiesC = (await third.db.all("SELECT body FROM posts ORDER BY id")).map((row) => row.body);
  assert.notDeepEqual(bodiesA, bodiesC, "a different seed produces a different thread");
});

test("every post the fixture writes says it is demonstration data", async () => {
  const { db, adminId, base } = await setup();
  const result = await seedTriageFixture(db, adminId);

  const posts = await db.all("SELECT body FROM posts");
  assert.equal(posts.length, 100);
  for (const post of posts) assert.match(post.body, /DEMONSTRATION DATA/, "a reader cannot mistake a fixture post for a contribution");

  // It surfaces publicly, so the labelling has to survive the page, not just
  // the row.
  const topic = await (await fetch(`${base}/topics/triage-fixture`)).text();
  assert.match(topic, /Demonstration/);
  const thread = await (await fetch(`${base}/threads/${result.threadId}`)).text();
  assert.match(thread, /DEMONSTRATION DATA/);
});

test("a moderator can open the fixture in the triage view", async () => {
  const { db, adminId, base } = await setup();
  const result = await seedTriageFixture(db, adminId);
  const cookie = await login(base);

  const triage = await fetch(`${base}/admin/threads/${result.threadId}`, { headers: { cookie } });
  assert.equal(triage.status, 200, "the view the three-minute measure is taken against renders at full size");
  const body = await triage.text();
  assert.match(body, /DEMONSTRATION DATA/);
  // The triage view has never been shown a thread this size before; these are
  // the things a moderator has to see to resolve one.
  assert.match(body, /contests|objection/i);

  const anonymous = await fetch(`${base}/admin/threads/${result.threadId}`, { redirect: "manual" });
  assert.notEqual(anonymous.status, 200, "triage stays behind moderator authorization");
});

test("the fixture is written once and refuses to run in production", async () => {
  const { db, adminId } = await setup();
  await seedTriageFixture(db, adminId);
  const again = await seedTriageFixture(db, adminId);
  assert.equal(again.created, false, "a second run does not double the thread");
  assert.equal((await db.all("SELECT id FROM posts")).length, 100);

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () => seedTriageFixture(db, adminId),
      /refuses to run in production/,
      "C4 makes posts permanent and attributed; fabricated ones must never reach a real record",
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
