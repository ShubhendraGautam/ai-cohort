import { hashPassword, randomToken } from "../auth.js";
import { audit } from "../db.js";
import { redirect, required, send, slugify, webBody } from "../http/primitives.js";
import { adminPage } from "../pages/admin-page.js";
import { instrumentationPage } from "../pages/instrumentation-page.js";
import { triagePage } from "../pages/triage-page.js";
import { closeCohortsForOperator } from "../cohorts/service.js";
import { assertAdmin, assertCsrf } from "../security/operator-auth.js";

async function citedPostIds(db, threadId, body, client) {
  const requested = new Set(Object.keys(body).map((key) => key.match(/^cite_(\d+)$/)).filter(Boolean).map((match) => Number(match[1])));
  if (!requested.size) return [];
  const rows = await db.all("SELECT p.id FROM posts p LEFT JOIN post_redactions r ON r.post_id = p.id WHERE p.thread_id = $1 AND r.post_id IS NULL", [threadId], client);
  const citable = rows.map((row) => Number(row.id)).filter((id) => requested.has(id));
  if (citable.length !== requested.size) throw Object.assign(new Error("An artifact can only cite unredacted posts from its own thread"), { status: 400 });
  return citable;
}

export async function handleAdminRoutes(context) {
  const { req, res, path, db, operator, requireAdminMfa } = context;
  if (!path.startsWith("/admin")) return false;

  if (req.method === "GET" && path === "/admin") {
    assertAdmin(operator, requireAdminMfa);
    send(res, await adminPage(db, operator), { "cache-control": "private, no-store" });
    return true;
  }
  if (req.method === "GET" && path === "/admin/instrumentation") {
    assertAdmin(operator, requireAdminMfa);
    send(res, await instrumentationPage(db, operator), { "cache-control": "private, no-store" });
    return true;
  }
  if (req.method === "POST" && path === "/admin/operators") {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const email = required(body.email, "Email", 254).toLowerCase();
    const name = required(body.name, "Name", 120);
    const password = randomToken(18);
    const row = await db.one(`INSERT INTO operators (email, name, password_hash, role, verified_at) VALUES ($1, $2, $3, 'operator', NOW()) RETURNING id`, [email, name, hashPassword(password)]);
    await audit(db, operator.id, "create", "operator", row.id);
    send(res, await adminPage(db, operator, `Operator created. Give ${email} this temporary password: ${password}`), { "cache-control": "private, no-store" });
    return true;
  }
  if (req.method === "POST" && path === "/admin/topics") {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const row = await db.one(`INSERT INTO topics (slug, title, objective, admission_rules, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [slugify(body.slug), required(body.title, "Title", 140), required(body.objective, "Objective", 3000), required(body.admission_rules, "Admission rules", 3000), operator.id]);
    await audit(db, operator.id, "create", "topic", row.id);
    redirect(res, "/admin");
    return true;
  }
  if (req.method === "POST" && path === "/admin/threads") {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const cap = Number(body.participant_cap);
    if (!Number.isInteger(cap) || cap < 2 || cap > 20) throw Object.assign(new Error("Participant cap must be between 2 and 20"), { status: 400 });
    const row = await db.one(`INSERT INTO threads (topic_id, title, objective, participant_cap, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [Number(body.topic_id), required(body.title, "Title", 180), required(body.objective, "Objective", 5000), cap, operator.id]);
    await audit(db, operator.id, "create", "thread", row.id);
    redirect(res, "/admin");
    return true;
  }

  let match = path.match(/^\/admin\/threads\/(\d+)$/);
  if (req.method === "GET" && match) {
    assertAdmin(operator, requireAdminMfa);
    send(res, await triagePage(db, operator, Number(match[1])), { "cache-control": "private, no-store" });
    return true;
  }
  match = path.match(/^\/admin\/threads\/(\d+)\/admit$/);
  if (req.method === "POST" && match) {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const threadId = Number(match[1]); const agentId = Number(body.agent_id);
    await db.transaction(async (client) => {
      const thread = await db.maybeOne("SELECT * FROM threads WHERE id = $1 FOR UPDATE", [threadId], client);
      if (!thread || !["open", "frozen"].includes(thread.state)) throw Object.assign(new Error("Thread cannot accept participants"), { status: 409 });
      const agent = await db.maybeOne("SELECT id FROM agents WHERE id = $1 AND status = 'active'", [agentId], client);
      if (!agent) throw Object.assign(new Error("Only an approved active agent can be admitted"), { status: 409 });
      const count = await db.one("SELECT COUNT(*)::int AS count FROM thread_participants WHERE thread_id = $1", [threadId], client);
      if (count.count >= thread.participant_cap) throw Object.assign(new Error("Thread participant cap has been reached"), { status: 409 });
      await db.query("INSERT INTO thread_participants (thread_id, agent_id, admitted_by) VALUES ($1, $2, $3)", [threadId, agentId, operator.id], client);
      await audit(db, operator.id, "admit", "thread", threadId, null, { agentId }, client);
    });
    redirect(res, "/admin");
    return true;
  }
  match = path.match(/^\/admin\/threads\/(\d+)\/evict\/(\d+)$/);
  if (req.method === "POST" && match) {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const result = await db.query("DELETE FROM thread_participants WHERE thread_id = $1 AND agent_id = $2", [Number(match[1]), Number(match[2])]);
    if (!result.rowCount) throw Object.assign(new Error("That agent is not admitted to this thread"), { status: 404 });
    await audit(db, operator.id, "evict", "thread", Number(match[1]), null, { agentId: Number(match[2]) });
    redirect(res, "/admin");
    return true;
  }
  match = path.match(/^\/admin\/threads\/(\d+)\/state$/);
  if (req.method === "POST" && match) {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const state = String(body.state);
    if (!["open", "frozen", "closed-unresolved"].includes(state)) throw Object.assign(new Error("Invalid thread state"), { status: 400 });
    const result = await db.query("UPDATE threads SET state = $1, updated_at = NOW() WHERE id = $2 AND state != 'resolved'", [state, Number(match[1])]);
    if (!result.rowCount) throw Object.assign(new Error("Thread not found or already resolved"), { status: 409 });
    await audit(db, operator.id, state, "thread", Number(match[1]));
    redirect(res, "/admin");
    return true;
  }
  match = path.match(/^\/admin\/threads\/(\d+)\/resolve$/);
  if (req.method === "POST" && match) {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const threadId = Number(match[1]);
    await db.transaction(async (client) => {
      const thread = await db.maybeOne("SELECT state FROM threads WHERE id = $1 FOR UPDATE", [threadId], client);
      if (!thread || !["open", "frozen"].includes(thread.state)) throw Object.assign(new Error("Only an open or frozen thread can be resolved"), { status: 409 });
      const citations = await citedPostIds(db, threadId, body, client);
      const artifact = await db.one("INSERT INTO artifacts (thread_id, title, body, created_by) VALUES ($1, $2, $3, $4) RETURNING id", [threadId, required(body.title, "Artifact title", 180), required(body.body, "Artifact body", 20_000), operator.id], client);
      for (const postId of citations) await db.query("INSERT INTO artifact_citations (artifact_id, post_id) VALUES ($1, $2)", [artifact.id, postId], client);
      await db.query("UPDATE threads SET state = 'resolved', updated_at = NOW() WHERE id = $1", [threadId], client);
      await audit(db, operator.id, "resolve", "thread", threadId, null, { citations }, client);
    });
    redirect(res, `/threads/${threadId}`);
    return true;
  }
  if (req.method === "POST" && path === "/admin/redact") {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const postId = Number(body.post_id); const reason = required(body.reason, "Reason", 500);
    await db.query("INSERT INTO post_redactions (post_id, moderator_id, reason) VALUES ($1, $2, $3)", [postId, operator.id, reason]);
    await audit(db, operator.id, "redact", "post", postId, reason);
    const threadId = Number(body.thread_id);
    redirect(res, Number.isInteger(threadId) && threadId > 0 ? `/admin/threads/${threadId}` : "/admin");
    return true;
  }
  match = path.match(/^\/admin\/operators\/(\d+)\/status$/);
  if (req.method === "POST" && match) {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const id = Number(match[1]); const status = String(body.status);
    if (!["active", "suspended"].includes(status)) throw Object.assign(new Error("Invalid operator status"), { status: 400 });
    await db.transaction(async (client) => {
      const target = await db.maybeOne("SELECT role, status FROM operators WHERE id = $1 FOR UPDATE", [id], client);
      if (!target || target.role === "admin" || target.status === "deleted") throw Object.assign(new Error("That operator cannot be changed"), { status: 409 });
      await db.query("UPDATE operators SET status = $1 WHERE id = $2", [status, id], client);
      if (status === "suspended") {
        await db.query("DELETE FROM sessions WHERE operator_id = $1", [id], client);
        await db.query("UPDATE agents SET status = 'suspended' WHERE operator_id = $1", [id], client);
        await closeCohortsForOperator(db, id, client);
      }
      await audit(db, operator.id, status, "operator", id, null, {}, client);
    });
    redirect(res, "/admin");
    return true;
  }
  match = path.match(/^\/admin\/operators\/(\d+)\/delete$/);
  if (req.method === "POST" && match) {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const id = Number(match[1]);
    await db.transaction(async (client) => {
      const target = await db.maybeOne("SELECT role FROM operators WHERE id = $1 FOR UPDATE", [id], client);
      if (!target || target.role === "admin") throw Object.assign(new Error("That operator cannot be deleted"), { status: 409 });
      await db.query("DELETE FROM sessions WHERE operator_id = $1", [id], client);
      await db.query("UPDATE agents SET status = 'suspended' WHERE operator_id = $1", [id], client);
      await closeCohortsForOperator(db, id, client);
      await db.query("UPDATE operators SET email = $1, name = 'Deleted operator', status = 'deleted', deleted_at = NOW(), mfa_secret_ciphertext = NULL, mfa_pending_ciphertext = NULL, mfa_recovery_hashes = '[]'::jsonb WHERE id = $2", [`deleted-${id}@invalid.local`, id], client);
      await audit(db, operator.id, "delete-and-anonymize", "operator", id, null, {}, client);
    });
    redirect(res, "/admin");
    return true;
  }
  match = path.match(/^\/admin\/agents\/(\d+)\/status$/);
  if (req.method === "POST" && match) {
    assertAdmin(operator, requireAdminMfa); const body = await webBody(req); assertCsrf(operator, body);
    const id = Number(match[1]); const status = String(body.status);
    if (!["active", "suspended"].includes(status)) throw Object.assign(new Error("Invalid agent status"), { status: 400 });
    const result = await db.query(`UPDATE agents a SET status = $1, approved_by = CASE WHEN $1 = 'active' THEN $2 ELSE approved_by END, approved_at = CASE WHEN $1 = 'active' THEN NOW() ELSE approved_at END FROM operators o WHERE a.id = $3 AND o.id = a.operator_id AND o.status = 'active'`, [status, operator.id, id]);
    if (!result.rowCount) throw Object.assign(new Error("Agent or active operator not found"), { status: 404 });
    await audit(db, operator.id, status === "active" ? "approve-or-reactivate" : "suspend", "agent", id);
    redirect(res, "/admin");
    return true;
  }
  return false;
}
