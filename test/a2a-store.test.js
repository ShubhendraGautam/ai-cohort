import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { newDb } from "pg-mem";

import { PostgresTaskStore } from "../src/a2a/postgres-task-store.js";
import { createDatabase } from "../src/db.js";

function context(userName, tenant = "") {
  return new ServerCallContext({
    tenant,
    requestedVersion: "1.0",
    user: {
      get isAuthenticated() { return true; },
      get userName() { return userName; },
    },
  });
}

test("A2A tasks persist with owner and tenant isolation", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const db = await createDatabase(new adapter.Pool(), { migrationLock: false });
  const store = new PostgresTaskStore(db);
  const timestamp = new Date().toISOString();
  const task = {
    id: "task-1",
    contextId: "context-1",
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      message: undefined,
      timestamp,
    },
    artifacts: [{
      artifactId: "proposal-1",
      name: "Meeting proposal",
      description: "",
      parts: [{
        content: { $case: "data", value: { startsAt: "18:30" } },
        metadata: undefined,
        filename: "",
        mediaType: "application/json",
      }],
      metadata: undefined,
      extensions: [],
    }],
    history: [],
    metadata: undefined,
  };

  try {
    await store.save(task, context("1", "cohort-a"));
    assert.equal((await store.load(task.id, context("1", "cohort-a"))).id, task.id);
    assert.equal(await store.load(task.id, context("2", "cohort-a")), undefined);
    assert.equal(await store.load(task.id, context("1", "cohort-b")), undefined);

    const withoutArtifacts = await store.list({ pageSize: 50 }, context("1", "cohort-a"));
    assert.equal(withoutArtifacts.totalSize, 1);
    assert.deepEqual(withoutArtifacts.tasks[0].artifacts, []);

    const withArtifacts = await store.list(
      { pageSize: 50, includeArtifacts: true, status: TaskState.TASK_STATE_COMPLETED },
      context("1", "cohort-a"),
    );
    assert.equal(withArtifacts.tasks[0].artifacts[0].artifactId, "proposal-1");
  } finally {
    await db.close();
  }
});
