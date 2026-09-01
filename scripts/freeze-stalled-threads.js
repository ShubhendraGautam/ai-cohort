#!/usr/bin/env node
import { configuredThreadStaleAfterDays, freezeStalledThreads, openDatabase } from "../src/db.js";

const db = await openDatabase(process.env.DATABASE_URL, { migrate: false });
try {
  const staleAfterDays = configuredThreadStaleAfterDays();
  const frozen = await freezeStalledThreads(db, { staleAfterDays });
  console.log(JSON.stringify({ frozenThreads: frozen.length, threadIds: frozen }));
} finally {
  await db.close();
}
