import { Task, TaskState } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";

function scope(context) {
  if (!context.user?.isAuthenticated || !context.user.userName) {
    throw Object.assign(new Error("Authenticated agent identity is required"), { status: 401 });
  }
  return {
    owner: context.user.userName,
    tenant: context.tenant || "",
  };
}

function pageCursor(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const separator = decoded.indexOf("|");
    if (separator < 1) throw new Error();
    const timestamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!id || Number.isNaN(new Date(timestamp).getTime())) throw new Error();
    return { timestamp, id };
  } catch {
    throw new RequestMalformedError("Invalid A2A task page token");
  }
}

export class PostgresTaskStore {
  constructor(db) {
    this.db = db;
  }

  async save(task, context) {
    const { owner, tenant } = scope(context);
    await this.db.query(
      `INSERT INTO a2a_tasks
        (owner, tenant, task_id, context_id, status, status_timestamp, task, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (owner, tenant, task_id) DO UPDATE SET
         context_id = EXCLUDED.context_id,
         status = EXCLUDED.status,
         status_timestamp = EXCLUDED.status_timestamp,
         task = EXCLUDED.task,
         updated_at = NOW()`,
      [
        owner,
        tenant,
        task.id,
        task.contextId,
        task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
        task.status?.timestamp || null,
        JSON.stringify(Task.toJSON(task)),
      ],
    );
  }

  async load(taskId, context) {
    const { owner, tenant } = scope(context);
    const row = await this.db.maybeOne(
      "SELECT task FROM a2a_tasks WHERE owner = $1 AND tenant = $2 AND task_id = $3",
      [owner, tenant, taskId],
    );
    return row ? Task.fromJSON(row.task) : undefined;
  }

  async list(params, context) {
    const { owner, tenant } = scope(context);
    const pageSize = Math.min(Math.max(params.pageSize || 50, 1), 100);
    const cursor = pageCursor(params.pageToken);
    const values = [owner, tenant];
    const where = ["owner = $1", "tenant = $2"];
    if (params.contextId) {
      values.push(params.contextId);
      where.push(`context_id = $${values.length}`);
    }
    if (params.status && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      values.push(params.status);
      where.push(`status = $${values.length}`);
    }
    if (params.statusTimestampAfter) {
      const timestamp = new Date(params.statusTimestampAfter);
      if (Number.isNaN(timestamp.getTime())) throw new RequestMalformedError("Invalid statusTimestampAfter value");
      values.push(timestamp.toISOString());
      where.push(`status_timestamp > $${values.length}`);
    }
    const countValues = [...values];
    const countWhere = [...where];
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      where.push(`(status_timestamp < $${values.length - 1} OR (status_timestamp = $${values.length - 1} AND task_id < $${values.length}))`);
    }
    const total = await this.db.one(
      `SELECT COUNT(*)::int AS count FROM a2a_tasks WHERE ${countWhere.join(" AND ")}`,
      countValues,
    );
    values.push(pageSize + 1);
    const rows = await this.db.all(
      `SELECT task_id, status_timestamp, task FROM a2a_tasks
       WHERE ${where.join(" AND ")}
       ORDER BY status_timestamp DESC NULLS LAST, task_id DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const tasks = page.map((row) => {
      const task = Task.fromJSON(row.task);
      if (!params.includeArtifacts) task.artifacts = [];
      return task;
    });
    let nextPageToken = "";
    if (hasMore) {
      const last = page.at(-1);
      nextPageToken = Buffer.from(`${new Date(last.status_timestamp).toISOString()}|${last.task_id}`).toString("base64");
    }
    return {
      tasks,
      nextPageToken,
      pageSize,
      totalSize: Number(total.count),
    };
  }
}
