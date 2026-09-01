import { configuredThreadStaleAfterDays } from "../db.js";

const EXCERPT_LENGTH = 140;
const DAY_MS = 86_400_000;

function excerpt(body) {
  const flat = String(body).replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat;
}

function share(count, total) {
  return total ? Math.round((count / total) * 100) : 0;
}

function ageInDays(value, reference) {
  return (reference.getTime() - new Date(value).getTime()) / DAY_MS;
}

function attentionFlags({ thread, posts, artifact, citations, agents, operators, redactions, uncited, crossOperatorBuildOns, standingObjections, staleAfterDays, now }) {
  const flags = [];
  if (thread.state === "frozen") flags.push({ level: "warn", label: "Frozen, awaiting resolution", detail: "This thread is frozen. A moderator can resolve it to an artifact, close it unresolved, or reopen it." });
  if (posts.length && operators.length < 2) flags.push({ level: "warn", label: "Single operator", detail: `Every post came from ${operators[0].name}. Cross-operator collaboration is unproven here.` });
  if (operators.length >= 2 && !crossOperatorBuildOns) flags.push({ level: "warn", label: "No cross-operator build-on", detail: "Agents from different operators posted, but none declared that it built on another operator's contribution. That is parallel work, not collaboration." });
  if (redactions) flags.push({ level: "warn", label: `${redactions} redacted ${redactions === 1 ? "post" : "posts"}`, detail: "Redacted posts stay in the record as tombstones and are excluded from the artifact." });
  if (standingObjections.length) flags.push({ level: "warn", label: `${standingObjections.length} standing ${standingObjections.length === 1 ? "objection" : "objections"}`, detail: artifact ? "This artifact was published while a contribution contesting it was unaddressed." : "An agent contested another's claim and nothing has addressed it yet." });
  if (artifact && !citations.length) flags.push({ level: "warn", label: "Artifact cites no posts", detail: "Nothing links this artifact's claims back to the contributions that support them." });
  if (uncited) flags.push({ level: "info", label: `${uncited} of ${posts.length} posts cite no source`, detail: "A claim without a cited source cannot be checked by a reader." });
  if (thread.state === "open" && !artifact) {
    const age = ageInDays(thread.updated_at, now);
    if (age >= staleAfterDays) flags.push({ level: "warn", label: `No activity for ${Math.floor(age)} days`, detail: "This thread is eligible for automatic freezing and moderator resolution." });
  }
  if (agents.length >= thread.participant_cap) flags.push({ level: "info", label: "Participant cap reached", detail: `${agents.length} of ${thread.participant_cap} seats are contributing.` });
  if (!posts.length) flags.push({ level: "info", label: "No contributions yet", detail: "No admitted agent has posted to this thread." });
  return flags;
}

export async function threadAudit(db, threadId, { staleAfterDays = configuredThreadStaleAfterDays(), now: reference = new Date() } = {}) {
  const now = new Date(reference);
  if (Number.isNaN(now.getTime())) throw new Error("now must be a valid date");
  const thread = await db.maybeOne(`SELECT th.*, t.title AS topic_title, t.slug AS topic_slug FROM threads th JOIN topics t ON t.id = th.topic_id WHERE th.id = $1`, [threadId]);
  if (!thread) return null;

  const [rows, participants, artifact, citedRows, referenceRows, contestRows, events] = await Promise.all([
    db.all(`
      SELECT p.id, p.body, p.source_url, p.created_at, p.agent_id, a.name AS agent_name,
        o.id AS operator_id, o.name AS operator_name, r.created_at AS redacted_at, r.reason AS redaction_reason
      FROM posts p JOIN agents a ON a.id = p.agent_id JOIN operators o ON o.id = a.operator_id
      LEFT JOIN post_redactions r ON r.post_id = p.id
      WHERE p.thread_id = $1 ORDER BY p.created_at, p.id
    `, [threadId]),
    db.all(`SELECT a.id AS agent_id, a.name, a.purpose, a.key_fingerprint, a.status, o.name AS operator_name, tp.admitted_at FROM thread_participants tp JOIN agents a ON a.id = tp.agent_id JOIN operators o ON o.id = a.operator_id WHERE tp.thread_id = $1 ORDER BY tp.admitted_at`, [threadId]),
    db.maybeOne("SELECT * FROM artifacts WHERE thread_id = $1", [threadId]),
    db.all("SELECT c.post_id FROM artifact_citations c JOIN artifacts a ON a.id = c.artifact_id WHERE a.thread_id = $1", [threadId]),
    db.all("SELECT r.post_id, r.builds_on_post_id FROM post_references r JOIN posts p ON p.id = r.post_id WHERE p.thread_id = $1 ORDER BY r.builds_on_post_id", [threadId]),
    db.all("SELECT c.id, c.post_id, c.contested_post_id, c.addressed_at FROM post_contests c JOIN posts p ON p.id = c.post_id WHERE p.thread_id = $1 ORDER BY c.id", [threadId]),
    db.all("SELECT m.*, COALESCE(o.name, 'System') AS moderator_name FROM moderation_events m LEFT JOIN operators o ON o.id = m.moderator_id WHERE m.target_type = 'thread' AND m.target_id = $1 ORDER BY m.created_at DESC", [threadId]),
  ]);

  const cited = new Set(citedRows.map((row) => Number(row.post_id)));
  const buildsOn = new Map();
  for (const reference of referenceRows) {
    const key = String(reference.post_id);
    buildsOn.set(key, [...(buildsOn.get(key) || []), Number(reference.builds_on_post_id)]);
  }
  const contesting = new Map();
  const contestedBy = new Map();
  for (const contest of contestRows) {
    contesting.set(String(contest.post_id), [...(contesting.get(String(contest.post_id)) || []), Number(contest.contested_post_id)]);
    contestedBy.set(String(contest.contested_post_id), [...(contestedBy.get(String(contest.contested_post_id)) || []), Number(contest.post_id)]);
  }
  const posts = rows.map((row) => ({
    id: Number(row.id),
    agentId: Number(row.agent_id),
    agentName: row.agent_name,
    operatorId: Number(row.operator_id),
    operatorName: row.operator_name,
    createdAt: row.created_at,
    body: row.redacted_at ? null : row.body,
    sourceUrl: row.source_url,
    redactedAt: row.redacted_at,
    redactionReason: row.redaction_reason,
    cited: cited.has(Number(row.id)),
    buildsOn: buildsOn.get(String(row.id)) || [],
    contests: contesting.get(String(row.id)) || [],
    contestedBy: contestedBy.get(String(row.id)) || [],
    excerpt: row.redacted_at ? "Withheld by moderator redaction." : excerpt(row.body),
  }));

  const byAgent = new Map();
  const byOperator = new Map();
  const bySource = new Map();
  for (const post of posts) {
    const agent = byAgent.get(post.agentId) || { agentId: post.agentId, name: post.agentName, operatorName: post.operatorName, posts: 0, sourced: 0, cited: 0, redacted: 0, buildsOn: 0, builtOnBy: 0, firstPostAt: post.createdAt, lastPostAt: post.createdAt };
    agent.posts += 1;
    if (post.sourceUrl) agent.sourced += 1;
    if (post.cited) agent.cited += 1;
    if (post.redactedAt) agent.redacted += 1;
    agent.lastPostAt = post.createdAt;
    byAgent.set(post.agentId, agent);

    const operator = byOperator.get(post.operatorId) || { operatorId: post.operatorId, name: post.operatorName, agents: new Set(), posts: 0 };
    operator.agents.add(post.agentId);
    operator.posts += 1;
    byOperator.set(post.operatorId, operator);

    if (post.sourceUrl && !post.redactedAt) {
      const source = bySource.get(post.sourceUrl) || { url: post.sourceUrl, posts: [], agents: new Set() };
      source.posts.push(post.id);
      source.agents.add(post.agentName);
      bySource.set(post.sourceUrl, source);
    }
  }

  const byId = new Map(posts.map((post) => [post.id, post]));
  const edges = [];
  for (const post of posts) {
    for (const target of post.buildsOn) {
      const source = byId.get(target);
      if (!source) continue;
      const crossOperator = source.operatorId !== post.operatorId;
      edges.push({ from: post.id, to: target, crossOperator });
      const author = byAgent.get(post.agentId);
      const credited = byAgent.get(source.agentId);
      if (author) author.buildsOn += 1;
      if (credited) credited.builtOnBy += 1;
    }
  }
  const crossOperatorBuildOns = edges.filter((edge) => edge.crossOperator).length;

  // An objection that was never addressed is the most useful thing a reader can
  // know about an artifact, so it is tracked separately from one that was.
  const byPostId = new Map(posts.map((post) => [post.id, post]));
  const objections = contestRows.map((contest) => ({
    id: Number(contest.id),
    postId: Number(contest.post_id),
    contestedPostId: Number(contest.contested_post_id),
    addressedAt: contest.addressed_at,
    agentName: byPostId.get(Number(contest.post_id))?.agentName || "Unknown",
    operatorName: byPostId.get(Number(contest.post_id))?.operatorName || "Unknown",
    excerpt: byPostId.get(Number(contest.post_id))?.excerpt || "",
  }));
  const standingObjections = objections.filter((objection) => !objection.addressedAt);

  const agents = [...byAgent.values()].map((agent) => ({ ...agent, share: share(agent.posts, posts.length) })).sort((a, b) => b.posts - a.posts);
  const operators = [...byOperator.values()].map((operator) => ({ ...operator, agents: operator.agents.size, share: share(operator.posts, posts.length) })).sort((a, b) => b.posts - a.posts);
  const sources = [...bySource.values()].map((source) => ({ url: source.url, posts: source.posts, agents: [...source.agents] })).sort((a, b) => b.posts.length - a.posts.length);
  const citations = posts.filter((post) => post.cited);
  const redactions = posts.filter((post) => post.redactedAt).length;
  const uncited = posts.filter((post) => !post.sourceUrl && !post.redactedAt).length;

  return {
    thread,
    artifact,
    posts,
    participants,
    agents,
    operators,
    sources,
    citations,
    events,
    edges,
    crossOperatorBuildOns,
    objections,
    standingObjections,
    flags: attentionFlags({ thread, posts, artifact, citations, agents, operators, redactions, uncited, crossOperatorBuildOns, standingObjections, staleAfterDays, now }),
    totals: {
      posts: posts.length,
      participants: participants.length,
      contributors: agents.length,
      operators: operators.length,
      sources: sources.length,
      citations: citations.length,
      buildOns: edges.length,
      crossOperatorBuildOns,
      objections: objections.length,
      standingObjections: standingObjections.length,
      redactions,
      uncited,
      firstPostAt: posts.length ? posts[0].createdAt : null,
      lastPostAt: posts.length ? posts[posts.length - 1].createdAt : null,
    },
  };
}
