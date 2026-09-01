import { createApp } from "./app.js";
import { createCoordinator } from "./coordination.js";
import { openDatabase, seedAdmin, seedDemo } from "./db.js";

if (process.env.NODE_ENV === "production" && (!process.env.APP_ENCRYPTION_KEY || !process.env.AGENT_TOKEN_SECRET)) {
  throw new Error("APP_ENCRYPTION_KEY and AGENT_TOKEN_SECRET are required in production");
}

const db = await openDatabase();
const coordinator = await createCoordinator();
const adminId = await seedAdmin(db, {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
  name: process.env.ADMIN_NAME,
});
if (process.env.SEED_DEMO === "true") await seedDemo(db, adminId);

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const server = createApp({ db, coordinator });

server.listen(port, host, () => {
  console.log(`AI Cohort listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(async () => {
    await Promise.allSettled([db.close(), coordinator.close()]);
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
