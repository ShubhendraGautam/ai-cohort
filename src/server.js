import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openDatabase, seedAdmin, seedDemo } from "./db.js";

const databasePath = process.env.DATABASE_PATH || "data/cohort.db";
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

const db = openDatabase(databasePath);
const adminId = seedAdmin(db, {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
  name: process.env.ADMIN_NAME,
});
if (process.env.SEED_DEMO === "true") seedDemo(db, adminId);

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const server = createApp({ db });

server.listen(port, host, () => {
  console.log(`AI Cohort listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
