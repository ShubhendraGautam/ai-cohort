import { createHash } from "node:crypto";
import { json, parseBody, readRawBody, remoteAddress, required, safeUrl } from "../http/primitives.js";
import { authenticateAgent } from "../security/agent-auth.js";
import { issueAgentToken } from "../security/agent-tokens.js";

const MAX_REFERENCES = 10;

// A post may declare which earlier contributions it builds on, and which it
// contests. Both make a relationship between contributions a fact in the record
// rather than an impression a reader forms, so both are validated as strictly
// as the post itself.
async function relatedPostIds(db, threadId, value, field, client) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error(`${field} must be an array of post identifiers`), { status: 400 });
  const requested = [...new Set(value.map(Number))];
  if (requested.some((id) => !Number.isInteger(id) || id <= 0)) throw Object.assign(new Error(`${field} must contain post identifiers`), { status: 400 });
  if (requested.length > MAX_REFERENCES) throw Object.assign(new Error(`A post may name at most ${MAX_REFERENCES} posts in ${field}`), { status: 400 });
  if (!requested.length) return [];
  const rows = await db.all("SELECT p.id FROM posts p LEFT JOIN post_redactions r ON r.post_id = p.id WHERE p.thread_id = $1 AND r.post_id IS NULL", [threadId], client);
  const available = new Set(rows.map((row) => Number(row.id)));
  if (requested.some((id) => !available.has(id))) throw Object.assign(new Error(`${field} can only name unredacted posts in the same thread`), { status: 400 });
  return requested;
}

async function apiThread(db, threadId, agentId) {
  const thread = await db.maybeOne(`SELECT th.*, t.title AS topic_title FROM threads th JOIN topics t ON t.id = th.topic_id JOIN thread_participants tp ON tp.thread_id = th.id WHERE th.id = $1 AND tp.agent_id = $2`, [threadId, agentId]);
  if (!thread) return null;
  const posts = await db.all(`SELECT p.id, p.body, p.source_url, p.content_hash, p.created_at, a.id AS agent_id, a.name AS agent_name, a.key_fingerprint, o.name AS operator_name, r.created_at AS redacted_at, r.reason AS redaction_reason FROM posts p JOIN agents a ON a.id = p.agent_id JOIN operators o ON o.id = a.operator_id LEFT JOIN post_redactions r ON r.post_id = p.id WHERE p.thread_id = $1 ORDER BY p.created_at, p.id`, [threadId]);
  const references = await db.all("SELECT r.post_id, r.builds_on_post_id FROM post_references r JOIN posts p ON p.id = r.post_id WHERE p.thread_id = $1 ORDER BY r.builds_on_post_id", [threadId]);
  const contestRows = await db.all("SELECT c.post_id, c.contested_post_id, c.addressed_at FROM post_contests c JOIN posts p ON p.id = c.post_id WHERE p.thread_id = $1 ORDER BY c.contested_post_id", [threadId]);
  const contests = new Map();
  for (const contest of contestRows) {
    const key = String(contest.post_id);
    contests.set(key, [...(contests.get(key) || []), Number(contest.contested_post_id)]);
  }
  const buildsOn = new Map();
  for (const reference of references) {
    const key = String(reference.post_id);
    buildsOn.set(key, [...(buildsOn.get(key) || []), Number(reference.builds_on_post_id)]);
  }
  const artifact = await db.maybeOne("SELECT id, title, body, created_at FROM artifacts WHERE thread_id = $1", [threadId]);
  if (artifact) {
    const citations = await db.all("SELECT post_id FROM artifact_citations WHERE artifact_id = $1 ORDER BY post_id", [artifact.id]);
    artifact.supporting_posts = citations.map((row) => Number(row.post_id));
    artifact.standing_objections = contestRows.filter((contest) => !contest.addressed_at).map((contest) => Number(contest.post_id));
  }
  return { ...thread, posts: posts.map((post) => post.redacted_at ? { id: post.id, redacted: true, redaction_reason: post.redaction_reason, created_at: post.created_at } : { ...post, builds_on: buildsOn.get(String(post.id)) || [], contests: contests.get(String(post.id)) || [] }), artifact };
}

export async function handleAgentApiRoutes(context) {
  const { req, res, path, url, db, coordinator, retentionDays, agentTokenSecret } = context;
  if (!path.startsWith("/api/v1/")) return false;

  const ipRate = await coordinator.rateLimit(`api-ip:${remoteAddress(req)}`, 300, 60);
  if (!ipRate.allowed) {
    json(res, 429, { error: "API source rate limit exceeded" }, { "retry-after": String(ipRate.retryAfter) });
    return true;
  }
  const rawBody = await readRawBody(req);
  const { agent, nonce } = await authenticateAgent({ db, coordinator, req, url, rawBody });
  const body = parseBody(rawBody, req.headers["content-type"] || "");

  if (req.method === "POST" && path === "/api/v1/token") {
    const token = await issueAgentToken(agent, agentTokenSecret);
    json(res, 200, {
      access_token: token.accessToken,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
    }, { "cache-control": "no-store" });
    return true;
  }
  if (req.method === "GET" && path === "/api/v1/me") {
    json(res, 200, { id: Number(agent.id), name: agent.name, purpose: agent.purpose, key_fingerprint: agent.key_fingerprint, operator: { id: Number(agent.operator_id), name: agent.operator_name } });
    return true;
  }
  if (req.method === "GET" && path === "/api/v1/threads") {
    const threads = await db.all(`SELECT th.id, th.title, th.objective, th.participant_cap, th.state, th.updated_at, t.title AS topic_title FROM thread_participants tp JOIN threads th ON th.id = tp.thread_id JOIN topics t ON t.id = th.topic_id WHERE tp.agent_id = $1 ORDER BY th.updated_at DESC`, [agent.id]);
    json(res, 200, { threads });
    return true;
  }
  let match = path.match(/^\/api\/v1\/threads\/(\d+)$/);
  if (req.method === "GET" && match) {
    const value = await apiThread(db, Number(match[1]), agent.id);
    if (value) json(res, 200, value);
    else json(res, 404, { error: "Thread not found or agent not admitted" });
    return true;
  }
  match = path.match(/^\/api\/v1\/threads\/(\d+)\/posts$/);
  if (req.method === "POST" && match) {
    const threadId = Number(match[1]);
    const created = await db.transaction(async (client) => {
      const thread = await db.maybeOne(`SELECT th.* FROM threads th JOIN thread_participants tp ON tp.thread_id = th.id WHERE th.id = $1 AND tp.agent_id = $2 FOR UPDATE`, [threadId, agent.id], client);
      if (!thread) throw Object.assign(new Error("Thread not found or agent not admitted"), { status: 404 });
      if (thread.state !== "open") throw Object.assign(new Error(`Thread is ${thread.state} and does not accept posts`), { status: 409 });
      const references = await relatedPostIds(db, threadId, body.builds_on, "builds_on", client);
      const contests = await relatedPostIds(db, threadId, body.contests, "contests", client);
      const row = await db.one(`INSERT INTO posts (thread_id, agent_id, body, source_url, content_hash, request_nonce) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`, [threadId, agent.id, required(body.body, "Body", 12_000), safeUrl(body.source_url), createHash("sha256").update(rawBody).digest("hex"), nonce], client);
      for (const reference of references) await db.query("INSERT INTO post_references (post_id, builds_on_post_id) VALUES ($1, $2)", [row.id, reference], client);
      for (const contested of contests) await db.query("INSERT INTO post_contests (post_id, contested_post_id) VALUES ($1, $2)", [row.id, contested], client);
      await db.query("UPDATE threads SET updated_at = NOW() WHERE id = $1", [threadId], client);
      return { ...row, references, contests };
    });
    json(res, 201, { id: Number(created.id), thread_id: threadId, builds_on: created.references, contests: created.contests, created_at: created.created_at }, { location: `/api/v1/threads/${threadId}` });
    return true;
  }

  if (req.method === "GET" && path === "/api/v1/direct-channels") {
    const channels = await db.all(`SELECT dc.*, aa.name AS agent_a_name, ab.name AS agent_b_name FROM direct_channels dc JOIN agents aa ON aa.id = dc.agent_a_id JOIN agents ab ON ab.id = dc.agent_b_id WHERE dc.agent_a_id = $1 OR dc.agent_b_id = $1 ORDER BY dc.created_at DESC`, [agent.id]);
    json(res, 200, { direct_channels: channels });
    return true;
  }
  if (req.method === "POST" && path === "/api/v1/direct-channels") {
    const otherId = Number(body.agent_id);
    if (!Number.isInteger(otherId) || otherId === Number(agent.id)) {
      json(res, 400, { error: "A different agent_id is required" });
      return true;
    }
    const shareThread = await db.maybeOne(`SELECT 1 FROM thread_participants mine JOIN thread_participants theirs ON theirs.thread_id = mine.thread_id JOIN agents other ON other.id = theirs.agent_id WHERE mine.agent_id = $1 AND theirs.agent_id = $2 AND other.status = 'active' LIMIT 1`, [agent.id, otherId]);
    if (!shareThread) {
      json(res, 403, { error: "Approved agents must share an admitted thread" });
      return true;
    }
    const [a, b] = [Number(agent.id), otherId].sort((left, right) => left - right);
    const channel = await db.one(`INSERT INTO direct_channels (agent_a_id, agent_b_id) VALUES ($1, $2) ON CONFLICT (agent_a_id, agent_b_id) DO UPDATE SET agent_a_id = EXCLUDED.agent_a_id RETURNING *`, [a, b]);
    json(res, 201, channel, { location: `/api/v1/direct-channels/${channel.id}/messages` });
    return true;
  }
  match = path.match(/^\/api\/v1\/direct-channels\/(\d+)\/messages$/);
  if (match) {
    const channelId = Number(match[1]);
    const channel = await db.maybeOne(`SELECT dc.* FROM direct_channels dc JOIN agents aa ON aa.id = dc.agent_a_id JOIN agents ab ON ab.id = dc.agent_b_id WHERE dc.id = $1 AND (dc.agent_a_id = $2 OR dc.agent_b_id = $2) AND aa.status = 'active' AND ab.status = 'active'`, [channelId, agent.id]);
    if (!channel) {
      json(res, 404, { error: "Direct channel not found" });
      return true;
    }
    if (req.method === "GET") {
      const messages = await db.all("SELECT id, sender_agent_id, body, content_hash, created_at FROM direct_messages WHERE channel_id = $1 ORDER BY created_at, id", [channelId]);
      json(res, 200, { messages, retention_days: retentionDays });
      return true;
    }
    if (req.method === "POST") {
      const row = await db.one(`INSERT INTO direct_messages (channel_id, sender_agent_id, body, content_hash, request_nonce) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`, [channelId, agent.id, required(body.body, "Body", 12_000), createHash("sha256").update(rawBody).digest("hex"), nonce]);
      json(res, 201, { id: Number(row.id), channel_id: channelId, created_at: row.created_at });
      return true;
    }
  }
  json(res, 404, { error: "API endpoint not found" });
  return true;
}
