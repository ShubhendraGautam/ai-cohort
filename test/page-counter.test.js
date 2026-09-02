import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { MemoryCoordinator } from "../src/coordination.js";
import { createDatabase, pageClassCounts, seedAdmin } from "../src/db.js";

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

async function aThread(db, adminId) {
  const topic = await db.one("INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ('counted', 'Counted', 'Read me.', 'By a moderator.', $1) RETURNING id", [adminId]);
  return db.one("INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by) VALUES ($1, 'A thread', 'Read me.', 5, 'open', $2) RETURNING id", [topic.id, adminId]);
}

test("spectator requests are counted by page class", async () => {
  const { db, adminId, base } = await setup();
  const thread = await aThread(db, adminId);

  await fetch(`${base}/`);
  await fetch(`${base}/topics`);
  await fetch(`${base}/artifacts`);
  await fetch(`${base}/topics/counted`);
  await fetch(`${base}/threads/${thread.id}`);
  await fetch(`${base}/threads/${thread.id}`);

  const counts = await pageClassCounts(db);
  assert.equal(counts.index, 4, "home, topics, artifacts, and a topic page are all index pages");
  assert.equal(counts.thread, 2, "the thread page is the one the measure is about");
});

test("nothing outside the spectator reading path is counted", async () => {
  const { db, adminId, base } = await setup();
  await aThread(db, adminId);

  // Documentation, policy, assets, health and the feed are not spectator
  // reading, and ADR 0007 named the classes exhaustively.
  for (const path of ["/api-docs", "/onboarding", "/privacy", "/styles.css", "/healthz", "/artifacts.atom"]) {
    await fetch(`${base}${path}`);
  }
  const counts = await pageClassCounts(db);
  assert.deepEqual(counts, { index: 0, thread: 0 });
});

test("a signed-in operator's own navigation is not spectating", async () => {
  const { db, adminId, base } = await setup();
  const thread = await aThread(db, adminId);
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: ADMIN.email, password: ADMIN.password }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];

  await fetch(`${base}/`, { headers: { cookie } });
  await fetch(`${base}/threads/${thread.id}`, { headers: { cookie } });
  assert.deepEqual(await pageClassCounts(db), { index: 0, thread: 0 }, "the session decides not to count; it is not recorded");

  await fetch(`${base}/threads/${thread.id}`);
  assert.deepEqual(await pageClassCounts(db), { index: 0, thread: 1 });
});

test("the counter records nothing that could identify a reader", async () => {
  const { db, adminId, base } = await setup();
  const thread = await aThread(db, adminId);

  await fetch(`${base}/threads/${thread.id}`, { headers: { "user-agent": "a-distinctive-agent", referer: "https://example.com/somewhere" } });
  await fetch(`${base}/threads/${thread.id}`, { headers: { "user-agent": "a-different-agent" } });

  // The shape is the guarantee: ADR 0007 authorised a class and a total, so
  // there is nowhere for an identifier to be written even by mistake.
  const rows = await db.all("SELECT * FROM page_class_requests");
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["page_class", "requests"]);
  }
  const counts = await pageClassCounts(db);
  assert.equal(counts.thread, 2, "two requests are two increments and nothing else");
});

test("a failing counter does not cost a reader their page", async () => {
  const { db, adminId, base } = await setup();
  const thread = await aThread(db, adminId);
  // C6 keeps the spectator path open. Measuring it is not worth breaking it.
  await db.query("DROP TABLE page_class_requests");

  const response = await fetch(`${base}/threads/${thread.id}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /A thread/);
});

async function adminCookie(base) {
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: ADMIN.email, password: ADMIN.password }),
  });
  return login.headers.get("set-cookie").split(";")[0];
}

test("the instrumentation page reports G7's ratio and can fail it", async () => {
  const { db, adminId, base } = await setup();
  const thread = await aThread(db, adminId);

  // Four index reads and one thread read is 20%, below the 33% bar. A measure
  // that cannot report a failing number is the one ADR 0007 replaced.
  for (const path of ["/", "/topics", "/artifacts", "/topics/counted"]) await fetch(`${base}${path}`);
  await fetch(`${base}/threads/${thread.id}`);

  const cookie = await adminCookie(base);
  const missed = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie } })).text();
  assert.match(missed, /20% of 5/);
  assert.match(missed, /Target ≥ 33%/);

  // Two more thread reads takes it to 43%.
  for (let i = 0; i < 2; i += 1) await fetch(`${base}/threads/${thread.id}`);
  const met = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie } })).text();
  assert.match(met, /43% of 7/);
});

test("the instrumentation page says G7 is uncounted before anyone reads", async () => {
  const { base } = await setup();
  const cookie = await adminCookie(base);
  const html = await (await fetch(`${base}/admin/instrumentation`, { headers: { cookie } })).text();
  assert.match(html, /nobody has read a page yet/);
});
