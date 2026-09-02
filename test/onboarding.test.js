import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { MemoryCoordinator } from "../src/coordination.js";
import { createDatabase, seedAdmin } from "../src/db.js";

const running = [];
const encryptionKey = randomBytes(32).toString("base64");
const ADMIN = { email: "admin@example.com", password: "correct-horse-battery", name: "Moderator" };

async function setup() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const pool = new (memory.adapters.createPg().Pool)();
  const db = await createDatabase(pool, { migrationLock: false });
  const adminId = await seedAdmin(db, ADMIN);
  const coordinator = new MemoryCoordinator();
  const server = createApp({ db, coordinator, encryptionKey, secureCookies: false, requireAdminMfa: false, retentionDays: 30, publicBaseUrl: "https://cohort.example" });
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

async function signIn(base, email, password) {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
  });
  assert.equal(response.status, 303);
  return { cookie: response.headers.get("set-cookie").split(";")[0], location: response.headers.get("location") };
}

async function csrfFrom(base, path, cookie) {
  const page = await fetch(`${base}${path}`, { headers: { cookie } });
  return (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
}

function form(fields) {
  return { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) };
}

// A moderator mints an operator and reads back the one-time password exactly as
// the moderation page shows it, because that string is what gets relayed.
async function inviteOperator(base, email = "newcomer@example.com") {
  const { cookie } = await signIn(base, ADMIN.email, ADMIN.password);
  const csrf = await csrfFrom(base, "/dashboard", cookie);
  const created = await fetch(`${base}/admin/operators`, {
    ...form({ email, name: "Newcomer", csrf }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(created.status, 200);
  const minted = (await created.text()).match(/one-time password: (\S+)/);
  assert.ok(minted, "the moderation page states the minted password");
  return { email, password: minted[1] };
}

// An operator past the rotation gate, holding a password they chose.
async function settledOperator(base, db, email = "settled@example.com") {
  const invited = await inviteOperator(base, email);
  const first = await signIn(base, invited.email, invited.password);
  const csrf = await csrfFrom(base, "/account/password", first.cookie);
  await fetch(`${base}/account/password`, {
    ...form({ current_password: invited.password, new_password: "a-password-i-chose", csrf }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: first.cookie },
  });
  const { cookie } = await signIn(base, invited.email, "a-password-i-chose");
  const operator = await db.one("SELECT id FROM operators WHERE email = $1", [email]);
  return { cookie, operatorId: operator.id };
}

async function seedThread(db, adminId) {
  const topic = await db.one("INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ('stage', 'Stage', 'Exercise the stage panel.', 'Admitted by a moderator.', $1) RETURNING id", [adminId]);
  return db.one("INSERT INTO threads (topic_id, title, objective, participant_cap, state, created_by) VALUES ($1, 'Stage thread', 'Exercise the stage panel.', 5, 'open', $2) RETURNING id", [topic.id, adminId]);
}

test("a minted password reaches the rotation form and nothing else", async () => {
  const { base } = await setup();
  const invited = await inviteOperator(base);
  const { cookie, location } = await signIn(base, invited.email, invited.password);
  assert.equal(location, "/dashboard");

  for (const path of ["/dashboard", "/cohorts", "/admin"]) {
    const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(response.status, 303, `${path} is gated`);
    assert.equal(response.headers.get("location"), "/account/password");
  }

  const rotation = await fetch(`${base}/account/password`, { headers: { cookie } });
  assert.equal(rotation.status, 200);
  assert.match(await rotation.text(), /Set your own password/);
});

test("the gate answers machine paths in JSON rather than redirecting", async () => {
  const { base } = await setup();
  const invited = await inviteOperator(base);
  const { cookie } = await signIn(base, invited.email, invited.password);

  const response = await fetch(`${base}/control/v1/assistants`, { headers: { cookie } });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Set a new password/);
});

test("reading stays open while a rotation is owed", async () => {
  const { base } = await setup();
  const invited = await inviteOperator(base);
  const { cookie } = await signIn(base, invited.email, invited.password);

  // C6: the spectator path never depends on an account, so it cannot depend on
  // the state of one either.
  for (const path of ["/", "/topics", "/artifacts", "/api-docs", "/onboarding"]) {
    const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(response.status, 200, `${path} stays readable`);
  }
});

test("rotating clears the gate, ends sessions, and requires the new password", async () => {
  const { base, db } = await setup();
  const invited = await inviteOperator(base);
  const { cookie } = await signIn(base, invited.email, invited.password);
  const csrf = await csrfFrom(base, "/account/password", cookie);

  const rotated = await fetch(`${base}/account/password`, {
    ...form({ current_password: invited.password, new_password: "a-password-i-chose", csrf }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(rotated.status, 303);
  assert.equal(rotated.headers.get("location"), "/login");

  const stale = await fetch(`${base}/dashboard`, { headers: { cookie }, redirect: "manual" });
  assert.equal(stale.status, 303);
  assert.equal(stale.headers.get("location"), "/login", "the rotating session is destroyed with the rest");

  const flag = await db.one("SELECT password_reset_required FROM operators WHERE email = $1", [invited.email]);
  assert.equal(flag.password_reset_required, false);

  const back = await signIn(base, invited.email, "a-password-i-chose");
  const dashboard = await fetch(`${base}/dashboard`, { headers: { cookie: back.cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Step 1 of 4/);
});

test("the minted password cannot be kept as the chosen one", async () => {
  const { base, db } = await setup();
  const invited = await inviteOperator(base);
  const { cookie } = await signIn(base, invited.email, invited.password);
  const csrf = await csrfFrom(base, "/account/password", cookie);

  const reused = await fetch(`${base}/account/password`, {
    ...form({ current_password: invited.password, new_password: invited.password, csrf }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(reused.status, 200);
  assert.match(await reused.text(), /different from the one you were given/);

  const flag = await db.one("SELECT password_reset_required FROM operators WHERE email = $1", [invited.email]);
  assert.equal(flag.password_reset_required, true, "the gate survives a refused rotation");
});

test("rotation refuses a wrong current password and a missing CSRF token", async () => {
  const { base } = await setup();
  const invited = await inviteOperator(base);
  const { cookie } = await signIn(base, invited.email, invited.password);
  const csrf = await csrfFrom(base, "/account/password", cookie);

  const wrong = await fetch(`${base}/account/password`, {
    ...form({ current_password: "not-the-minted-one", new_password: "a-password-i-chose", csrf }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(wrong.status, 200);
  assert.match(await wrong.text(), /one-time password was not accepted/);

  const forged = await fetch(`${base}/account/password`, {
    ...form({ current_password: invited.password, new_password: "a-password-i-chose" }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(forged.status, 403);

  const still = await fetch(`${base}/dashboard`, { headers: { cookie }, redirect: "manual" });
  assert.equal(still.headers.get("location"), "/account/password");
});

test("an operator who chose their own password is never gated", async () => {
  const { base } = await setup();
  // The bootstrap admin sets its own password from configuration, so it owes
  // no rotation and must not be caught by the gate.
  const { cookie } = await signIn(base, ADMIN.email, ADMIN.password);
  const dashboard = await fetch(`${base}/dashboard`, { headers: { cookie }, redirect: "manual" });
  assert.equal(dashboard.status, 200);

  const rotation = await fetch(`${base}/account/password`, { headers: { cookie }, redirect: "manual" });
  assert.equal(rotation.status, 303);
  assert.equal(rotation.headers.get("location"), "/dashboard", "the standalone form is only for a minted password");
});

test("the dashboard names the stage the operator is actually at", async () => {
  const { base, db } = await setup();
  const invited = await inviteOperator(base);
  const first = await signIn(base, invited.email, invited.password);
  const csrf = await csrfFrom(base, "/account/password", first.cookie);
  await fetch(`${base}/account/password`, {
    ...form({ current_password: invited.password, new_password: "a-password-i-chose", csrf }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: first.cookie },
  });

  const { cookie } = await signIn(base, invited.email, "a-password-i-chose");
  const before = await fetch(`${base}/dashboard`, { headers: { cookie } });
  assert.match(await before.text(), /Step 1 of 4 — Register an agent identity/);

  const operator = await db.one("SELECT id FROM operators WHERE email = $1", [invited.email]);
  await db.query("INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint) VALUES ($1, 'reader', 'reads', 'pem', 'fp')", [operator.id]);
  const pending = await fetch(`${base}/dashboard`, { headers: { cookie } });
  assert.match(await pending.text(), /Step 2 of 4 — Waiting for a moderator/);

  await db.query("UPDATE agents SET status = 'active' WHERE operator_id = $1", [operator.id]);
  const approved = await fetch(`${base}/dashboard`, { headers: { cookie } });
  assert.match(await approved.text(), /Step 3 of 4 — Waiting for admission/);
});

// Reported by codex against the first implementation, which asked whether any
// agent was active and, separately, whether any agent was admitted.
test("an admission held by a suspended agent is not progress for an active one", async () => {
  const { base, db, adminId } = await setup();
  const { cookie, operatorId } = await settledOperator(base, db);
  const thread = await seedThread(db, adminId);

  const active = await db.one("INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint, status) VALUES ($1, 'active-one', 'reads', 'pem-a', 'fp-a', 'active') RETURNING id", [operatorId]);
  const suspended = await db.one("INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint, status) VALUES ($1, 'suspended-one', 'reads', 'pem-b', 'fp-b', 'suspended') RETURNING id", [operatorId]);
  await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [thread.id, suspended.id, adminId]);

  // The active agent is unadmitted and the admitted agent cannot authenticate,
  // so no identity here can post.
  const mixed = await fetch(`${base}/dashboard`, { headers: { cookie } });
  assert.match(await mixed.text(), /Step 3 of 4 — Waiting for admission/);

  await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [thread.id, active.id, adminId]);
  const ready = await fetch(`${base}/dashboard`, { headers: { cookie } });
  assert.match(await ready.text(), /Step 4 of 4 — Sign a request and post/);
});

test("a suspended identity is not described as waiting for approval", async () => {
  const { base, db } = await setup();
  const { cookie, operatorId } = await settledOperator(base, db);
  await db.query("INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint, status) VALUES ($1, 'gone', 'reads', 'pem-c', 'fp-c', 'suspended')", [operatorId]);

  const response = await fetch(`${base}/dashboard`, { headers: { cookie } });
  const body = await response.text();
  assert.match(body, /Every identity you registered is suspended/);
  assert.doesNotMatch(body, /Waiting for a moderator to approve/, "suspension is a decision, not a stage to wait out");
  assert.doesNotMatch(body, /Step \d of 4/, "a suspended identity is not on the path");
});
