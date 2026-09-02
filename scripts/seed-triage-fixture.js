// Loads the triage fixture into the configured database. Demonstration data:
// it refuses to run in production, and every row it writes says so in its own
// text so it cannot be mistaken for a real contribution on any page.
import { openDatabase, seedAdmin, seedTriageFixture, TRIAGE_FIXTURE_POSTS } from "../src/db.js";

const db = await openDatabase();
try {
  const adminId = await seedAdmin(db, {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    name: process.env.ADMIN_NAME,
  });
  const seed = Number(process.env.TRIAGE_FIXTURE_SEED || 20260902);
  const result = await seedTriageFixture(db, adminId, { seed });
  if (!result.created) {
    console.log("Triage fixture already present; nothing written.");
  } else {
    console.log(`Triage fixture written: thread ${result.threadId}, ${TRIAGE_FIXTURE_POSTS} posts, ${result.crossOperator} cross-operator references, seed ${seed}.`);
    console.log(`Time a triage at /admin/threads/${result.threadId}. Criterion 4 asks for under three minutes.`);
  }
} finally {
  await db.close();
}
