import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { newDb } from "pg-mem";
import {
  configuredRetentionDays,
  configuredThreadStaleAfterDays,
  createDatabase,
  freezeStalledThreads,
  runMaintenance,
} from "../src/db.js";
import { threadAudit } from "../src/threads/audit.js";

let db;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function threadAt(updatedAt) {
  const admin = await db.one(`INSERT INTO operators (email, name, password_hash, role, verified_at)
    VALUES ($1, 'Moderator', $2, 'admin', NOW()) RETURNING id`, [`admin-${updatedAt}@example.com`, "hash"]);
  const topic = await db.one(`INSERT INTO topics (slug, title, objective, admission_rules, created_by)
    VALUES ($1, 'Topic', 'Objective', 'Invite', $2) RETURNING id`, [`topic-${admin.id}`, admin.id]);
  const thread = await db.one(`INSERT INTO threads (topic_id, title, objective, created_by, updated_at)
    VALUES ($1, 'Thread', 'Objective', $2, $3) RETURNING id`, [topic.id, admin.id, updatedAt]);
  return Number(thread.id);
}

test("freezeStalledThreads uses its supplied clock and includes the exact cutoff", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  db = await createDatabase(new adapter.Pool(), { migrationLock: false });
  const cutoffId = await threadAt("2026-08-25T12:00:00.000Z");
  const activeId = await threadAt("2026-08-25T12:00:00.001Z");

  const frozen = await freezeStalledThreads(db, {
    staleAfterDays: 7,
    now: "2026-09-01T12:00:00.000Z",
  });

  assert.deepEqual(frozen, [cutoffId]);
  assert.equal((await db.one("SELECT state FROM threads WHERE id = $1", [activeId])).state, "open");
  const warningId = await threadAt("2026-08-24T12:00:00.000Z");
  const warnedAtSeven = await threadAudit(db, warningId, { staleAfterDays: 7, now: "2026-09-01T12:00:00.000Z" });
  const warnedAtFourteen = await threadAudit(db, warningId, { staleAfterDays: 14, now: "2026-09-01T12:00:00.000Z" });
  assert.ok(warnedAtSeven.flags.some((flag) => flag.label === "No activity for 8 days"));
  assert.ok(!warnedAtFourteen.flags.some((flag) => flag.label.startsWith("No activity for")));

  assert.equal(configuredThreadStaleAfterDays("14"), 14);
  await assert.rejects(() => freezeStalledThreads(db, { staleAfterDays: 0 }), /THREAD_STALE_AFTER_DAYS/);
  await assert.rejects(() => freezeStalledThreads(db, { now: "not-a-date" }), /valid date/);
});

test("runMaintenance atomically prunes at the retention cutoff and records the run", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  db = await createDatabase(new adapter.Pool(), { migrationLock: false });
  const reference = "2026-09-01T12:00:00.000Z";
  const cutoff = "2026-08-02T12:00:00.000Z";

  const firstOperator = await db.one(`INSERT INTO operators (email, name, password_hash, verified_at)
    VALUES ('first@example.com', 'First', 'hash', NOW()) RETURNING id`);
  const secondOperator = await db.one(`INSERT INTO operators (email, name, password_hash, verified_at)
    VALUES ('second@example.com', 'Second', 'hash', NOW()) RETURNING id`);
  const firstAgent = await db.one(`INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint, status)
    VALUES ($1, 'First agent', 'Test maintenance', 'first-key', 'first-fingerprint', 'active') RETURNING id`, [firstOperator.id]);
  const secondAgent = await db.one(`INSERT INTO agents (operator_id, name, purpose, public_key_pem, key_fingerprint, status)
    VALUES ($1, 'Second agent', 'Test maintenance', 'second-key', 'second-fingerprint', 'active') RETURNING id`, [secondOperator.id]);
  const channel = await db.one("INSERT INTO direct_channels (agent_a_id, agent_b_id) VALUES ($1, $2) RETURNING id", [firstAgent.id, secondAgent.id]);
  await db.query(`INSERT INTO direct_messages (channel_id, sender_agent_id, body, content_hash, request_nonce, created_at) VALUES
    ($1, $2, 'expired', 'old-hash', 'old-direct', $3),
    ($1, $2, 'fresh', 'new-hash', 'new-direct', $4)`, [channel.id, firstAgent.id, cutoff, "2026-08-02T12:00:00.001Z"]);

  await db.query(`INSERT INTO assistant_cohort_invitations
    (id, inviter_operator_id, invitee_operator_id, inviter_agent_id, invitee_agent_id, purpose, policy, status, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001', $1, $2, $3, $4, 'Test maintenance', '{}'::jsonb, 'accepted', $5)`,
  [firstOperator.id, secondOperator.id, firstAgent.id, secondAgent.id, reference]);
  await db.query(`INSERT INTO assistant_cohorts (id, invitation_id, purpose, policy)
    VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Test maintenance', '{}'::jsonb)`);
  await db.query(`INSERT INTO assistant_cohort_messages
    (id, cohort_id, sender_agent_id, recipient_agent_id, context_id, parts, created_at) VALUES
    ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', $1, $2, 'old', '[]'::jsonb, $3),
    ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', $1, $2, 'new', '[]'::jsonb, $4)`,
  [firstAgent.id, secondAgent.id, cutoff, "2026-08-02T12:00:00.001Z"]);
  await db.query(`INSERT INTO sessions (token_hash, operator_id, csrf_token, expires_at) VALUES
    ('expired-session', $1, 'old-csrf', $2),
    ('fresh-session', $1, 'new-csrf', $3)`, [firstOperator.id, reference, "2026-09-01T12:00:00.001Z"]);

  const stalledId = await threadAt("2026-08-25T12:00:00.000Z");
  const result = await runMaintenance(db, { retentionDays: 30, staleAfterDays: 7, now: reference });

  assert.deepEqual(result, {
    ranAt: reference,
    retention: {
      retentionDays: 30,
      cutoff,
      deletedSessions: 1,
      deletedDirectMessages: 1,
      deletedCohortMessages: 1,
    },
    threadStaleAfterDays: 7,
    threadCutoff: "2026-08-25T12:00:00.000Z",
    frozenThreadIds: [stalledId],
  });
  assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM sessions")).count, 1);
  assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM direct_messages")).count, 1);
  assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM assistant_cohort_messages")).count, 1);
  const recorded = await db.one("SELECT actor_type, actor_id, event, remote_address, metadata, created_at FROM security_events WHERE event = 'maintenance-completed'");
  assert.equal(recorded.actor_type, "system");
  assert.equal(recorded.actor_id, null);
  assert.equal(recorded.remote_address, null);
  assert.deepEqual(recorded.metadata, {
    ranAt: reference,
    retention: result.retention,
    threadStaleAfterDays: 7,
    threadCutoff: "2026-08-25T12:00:00.000Z",
    frozenThreads: 1,
  });
  assert.equal(new Date(recorded.created_at).toISOString(), reference);

  assert.equal(configuredRetentionDays("14"), 14);
  assert.throws(() => configuredRetentionDays("1.5"), /positive integer/);
  await assert.rejects(() => runMaintenance(db, { now: "not-a-date" }), /valid date/);
});

test("a non-migrating database connection leaves schema authority to deployment", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  db = await createDatabase(new adapter.Pool(), { migrate: false });

  await assert.rejects(
    () => db.query("SELECT * FROM schema_migrations"),
    /schema_migrations|relation .* does not exist/i,
  );
});
