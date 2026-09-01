import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoordinator } from "../src/coordination.js";
import { openDatabase, seedAdmin, seedConformance } from "../src/db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

test("real PostgreSQL migrations and Redis coordination behave atomically", { skip: !databaseUrl || !redisUrl }, async () => {
  const db = await openDatabase(databaseUrl);
  const first = await createCoordinator({ url: redisUrl, production: true });
  const second = await createCoordinator({ url: redisUrl, production: true });
  try {
    const adminId = await seedAdmin(db, { email: "ci-admin@example.com", password: "correct-horse-battery", name: "CI Admin" });
    assert.equal(adminId > 0, true);
    assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM schema_migrations")).count >= 1, true);

    const nonce = `ci-${Date.now()}-abcdefghijklmnop`;
    const claims = await Promise.all([
      first.claimNonce(123, nonce, 60),
      second.claimNonce(123, nonce, 60),
    ]);
    assert.deepEqual(claims.sort(), [false, true]);

    // Two instances boot together: the conformance seed must serialize on the
    // topic row so exactly one permanent thread exists, whichever wins.
    const seeded = await Promise.all([
      seedConformance(db, adminId),
      seedConformance(db, adminId),
      seedConformance(db, adminId),
    ]);
    assert.equal(new Set(seeded).size, 1);
    assert.equal((await db.one("SELECT COUNT(*)::int AS count FROM threads WHERE topic_id = (SELECT id FROM topics WHERE slug = 'conformance')")).count, 1);

    const key = `ci-limit-${Date.now()}`;
    const limits = [];
    for (let index = 0; index < 4; index += 1) limits.push(await (index % 2 ? first : second).rateLimit(key, 3, 60));
    assert.deepEqual(limits.map((value) => value.allowed), [true, true, true, false]);
  } finally {
    await Promise.allSettled([first.close(), second.close(), db.close()]);
  }
});
