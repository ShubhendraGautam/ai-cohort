#!/usr/bin/env node
import {
  configuredRetentionDays,
  configuredThreadStaleAfterDays,
  openDatabase,
  runMaintenance,
} from "../src/db.js";

// Deploy startup owns schema migration. A scheduled job must not acquire schema
// locks every hour just because it needs a database connection.
const db = await openDatabase(process.env.DATABASE_URL, { migrate: false });
try {
  const result = await runMaintenance(db, {
    retentionDays: configuredRetentionDays(),
    staleAfterDays: configuredThreadStaleAfterDays(),
  });
  console.log(JSON.stringify(result));
} finally {
  await db.close();
}
