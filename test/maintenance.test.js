import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { newDb } from "pg-mem";
import { configuredThreadStaleAfterDays, createDatabase, freezeStalledThreads } from "../src/db.js";
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
