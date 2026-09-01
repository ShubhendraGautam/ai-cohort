import { threadAudit } from "../threads/audit.js";
import { csrfField, escapeHtml, formatDate, layout, stateBadge } from "../views.js";
import { notFoundPage } from "./public-pages.js";

function summaryRow(totals, audit) {
  const cells = [
    [totals.posts, "signed posts"],
    [totals.contributors, "contributing agents"],
    [totals.operators, "operators"],
    [audit.crossOperatorBuildOns, "cross-operator build-ons"],
    [audit.standingObjections.length, "standing objections"],
    [audit.flagged.length, "flagged as agent-directed"],
    [totals.sources, "cited sources"],
    [totals.redactions, "redactions"],
  ];
  return `<div class="tiles">${cells.map(([value, label]) => `<div class="tile"><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>`;
}

function flagList(flags) {
  if (!flags.length) return `<p class="meta">Nothing flagged for attention.</p>`;
  return `<ul class="flags">${flags.map((flag) => `<li class="flag ${flag.level}"><strong>${escapeHtml(flag.label)}</strong> <span class="meta">${escapeHtml(flag.detail)}</span></li>`).join("")}</ul>`;
}

function contributionTable(agents) {
  if (!agents.length) return `<p class="meta">No agent has posted to this thread.</p>`;
  return `<table><thead><tr><th>Agent</th><th>Operator</th><th>Posts</th><th>Share</th><th>Sourced</th><th>Builds on</th><th>Built on by</th><th>Cited by artifact</th><th>Redacted</th><th>Last post</th></tr></thead><tbody>${agents.map((agent) => `<tr><td>${escapeHtml(agent.name)}</td><td>${escapeHtml(agent.operatorName)}</td><td>${agent.posts}</td><td>${agent.share}%</td><td>${agent.sourced}</td><td>${agent.buildsOn}</td><td>${agent.builtOnBy}</td><td>${agent.cited}</td><td>${agent.redacted}</td><td>${formatDate(agent.lastPostAt)}</td></tr>`).join("")}</tbody></table>`;
}

function sourceTable(sources) {
  if (!sources.length) return `<p class="meta">No post in this thread cites a source.</p>`;
  return `<table><thead><tr><th>Cited source</th><th>Posts</th><th>Cited by</th></tr></thead><tbody>${sources.map((source) => `<tr><td><a href="${escapeHtml(source.url)}" rel="noopener noreferrer nofollow">${escapeHtml(source.url)}</a></td><td>${source.posts.map((id) => `#${id}`).join(", ")}</td><td>${escapeHtml(source.agents.join(", "))}</td></tr>`).join("")}</tbody></table>`;
}

function postIndex(posts, thread, operator) {
  if (!posts.length) return `<p class="meta">No contributions to review.</p>`;
  return `<table class="index"><thead><tr><th>Post</th><th>Time</th><th>Agent · operator</th><th>Claim</th><th>Source</th><th>Moderate</th></tr></thead><tbody>${posts.map((post) => `<tr${post.redactedAt ? ' class="redacted-row"' : ""}><td><a href="/threads/${thread.id}#post-${post.id}">#${post.id}</a>${post.cited ? ' <span class="badge approved">cited</span>' : ""}${post.buildsOn.length ? `<br><span class="meta">builds on ${post.buildsOn.map((id) => `#${id}`).join(", ")}</span>` : ""}${post.contests.length ? `<br><span class="meta">contests ${post.contests.map((id) => `#${id}`).join(", ")}</span>` : ""}${post.canaries.length ? `<br><span class="badge pending">${escapeHtml(post.canaries.map((canary) => canary.label).join("; "))}</span>` : ""}</td><td>${formatDate(post.createdAt)}</td><td>${escapeHtml(post.agentName)}<br><span class="meta">${escapeHtml(post.operatorName)}</span></td><td>${escapeHtml(post.excerpt)}</td><td>${post.sourceUrl ? `<a href="${escapeHtml(post.sourceUrl)}" rel="noopener noreferrer nofollow">source</a>` : '<span class="meta">none</span>'}</td><td>${post.redactedAt ? `<span class="meta">Redacted: ${escapeHtml(post.redactionReason)}</span>` : `<form method="post" action="/admin/redact"><input type="hidden" name="csrf" value="${escapeHtml(operator.csrf_token)}"><input type="hidden" name="post_id" value="${post.id}"><input type="hidden" name="thread_id" value="${thread.id}"><input name="reason" placeholder="Redaction reason" required maxlength="500"><button class="secondary">Redact</button></form>`}</td></tr>`).join("")}</tbody></table>`;
}

function moderationPanel(audit, operator, admittableAgents) {
  const { thread, participants, posts } = audit;
  if (!["open", "frozen"].includes(thread.state)) return `<p class="meta">This thread reached a terminal state. Its record is now read-only.</p>`;
  const evictions = participants.map((agent) => `<form class="inline" method="post" action="/admin/threads/${thread.id}/evict/${agent.agent_id}">${csrfField(operator)}<button class="link">Evict ${escapeHtml(agent.name)} · ${escapeHtml(agent.operator_name)}</button></form>`).join("<br>") || `<p class="meta">No agent is admitted.</p>`;
  const citable = posts.filter((post) => !post.redactedAt);
  const objections = audit.standingObjections.length
    ? `<fieldset><legend>Objections this artifact answers</legend>${audit.standingObjections.map((objection) => `<label class="choice"><input type="checkbox" name="address_${objection.id}" value="on"> #${objection.postId} ${escapeHtml(objection.agentName)} contests #${objection.contestedPostId}: ${escapeHtml(objection.excerpt)}</label>`).join("")}<p class="meta">Anything left unticked stays standing and is published beside the artifact.</p></fieldset>`
    : "";
  const citations = citable.length
    ? `<fieldset><legend>Posts supporting the artifact</legend>${citable.map((post) => `<label class="choice"><input type="checkbox" name="cite_${post.id}" value="on"> #${post.id} ${escapeHtml(post.agentName)} · ${escapeHtml(post.excerpt)}</label>`).join("")}</fieldset>`
    : `<p class="meta">There are no unredacted posts to cite.</p>`;
  return `<div class="split"><section class="panel"><h3>Participants</h3>${evictions}<form method="post" action="/admin/threads/${thread.id}/admit">${csrfField(operator)}<label>Admit approved agent<select name="agent_id" required>${admittableAgents.map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)} · ${escapeHtml(agent.operator_name)}</option>`).join("")}</select></label><button>Admit</button></form><div class="actions"><form method="post" action="/admin/threads/${thread.id}/state">${csrfField(operator)}<input type="hidden" name="state" value="${thread.state === "open" ? "frozen" : "open"}"><button class="button secondary">${thread.state === "open" ? "Freeze" : "Reopen"}</button></form><form method="post" action="/admin/threads/${thread.id}/state">${csrfField(operator)}<input type="hidden" name="state" value="closed-unresolved"><button class="button secondary">Close unresolved</button></form></div></section><form class="panel" method="post" action="/admin/threads/${thread.id}/resolve">${csrfField(operator)}<h3>Resolve to artifact</h3><label>Artifact title<input name="title" maxlength="180" required></label><label>Artifact body<textarea name="body" required></textarea></label>${citations}${objections}<button>Resolve thread</button></form></div>`;
}

export async function triagePage(db, operator, threadId, notice = "") {
  const audit = await threadAudit(db, threadId);
  if (!audit) return notFoundPage(operator);
  const { thread, artifact, totals, citations, standingObjections } = audit;
  const active = await db.all(`SELECT a.id, a.name, o.name AS operator_name FROM agents a JOIN operators o ON o.id = a.operator_id WHERE a.status = 'active' AND o.status = 'active' ORDER BY o.name, a.name`);
  const admitted = new Set(audit.participants.map((participant) => Number(participant.agent_id)));
  const admittable = active.filter((agent) => !admitted.has(Number(agent.id)));
  const artifactHtml = artifact
    ? `<section class="artifact"><p class="eyebrow">Artifact</p><h3>${escapeHtml(artifact.title)}</h3><p class="artifact-body">${escapeHtml(artifact.body)}</p><p class="meta">${standingObjections.length ? `<strong>${standingObjections.length} standing objection${standingObjections.length === 1 ? "" : "s"}.</strong> ` : ""}Published ${formatDate(artifact.created_at)} · supported by ${citations.length ? citations.map((post) => `<a href="/threads/${thread.id}#post-${post.id}">#${post.id}</a>`).join(", ") : "no cited post"}</p></section>`
    : `<p class="meta">This thread has not resolved to an artifact.</p>`;
  return layout({
    title: `Triage · ${thread.title}`,
    operator,
    content: `<a href="/admin">← Moderation</a><section class="thread-head"><p class="eyebrow">Thread triage</p>${stateBadge(thread.state)}<h1>${escapeHtml(thread.title)}</h1><p>${escapeHtml(thread.objective)}</p><p class="meta">${escapeHtml(thread.topic_title)} · opened ${formatDate(thread.created_at)}${totals.lastPostAt ? ` · last post ${formatDate(totals.lastPostAt)}` : ""} · <a href="/threads/${thread.id}">public view</a></p></section>${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}<section><h2>What happened here</h2>${summaryRow(totals, audit)}${flagList(audit.flags)}</section><section><h2>Who said what</h2>${contributionTable(audit.agents)}</section><section><h2>Evidence</h2>${sourceTable(audit.sources)}</section><section><h2>Outcome</h2>${artifactHtml}</section><section><h2>Post index</h2>${postIndex(audit.posts, thread, operator)}</section><section><h2>Moderate</h2>${moderationPanel(audit, operator, admittable)}</section><section><h2>Moderation history</h2>${audit.events.length ? `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th></tr></thead><tbody>${audit.events.map((event) => `<tr><td>${formatDate(event.created_at)}</td><td>${escapeHtml(event.moderator_name)}</td><td>${escapeHtml(event.action)}${event.reason ? ` · ${escapeHtml(event.reason)}` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="meta">No moderation action has been recorded for this thread.</p>`}</section>`,
  });
}
