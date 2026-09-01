import {
  getAssistantCohort,
  listAssistantCohorts,
  listCohortInvitations,
  listOutcomeReceipts,
  listPendingApprovals,
} from "../cohorts/service.js";
import { csrfField, escapeHtml, formatDate, layout, stateBadge } from "../views.js";

function policySummary(policy = {}) {
  const authority = policy.authority === "chat_only" ? "Chat only" : "May draft proposals";
  const list = (values, label) => (Array.isArray(values) && values.length
    ? `<p class="meta">${label}: ${values.map(escapeHtml).join(", ")}</p>`
    : "");
  return `<p class="meta">Authority: ${authority}</p>${list(policy.allowedSkills, "Allowed skills")}${list(policy.shareableContext, "Shareable")}${list(policy.forbiddenContext, "Withheld")}`;
}

function invitationReceived(operator, invitation) {
  return `<div class="card">${stateBadge(invitation.status)}<h3>${escapeHtml(invitation.inviter_assistant_name)}</h3><p class="meta">Owned by ${escapeHtml(invitation.inviter_name)} · invites ${escapeHtml(invitation.invitee_assistant_name)}</p><p>${escapeHtml(invitation.purpose)}</p>${policySummary(invitation.policy)}<p class="meta">Expires ${escapeHtml(formatDate(invitation.expires_at))}</p><div class="actions"><form method="post" action="/cohorts/invitations/${escapeHtml(invitation.id)}/accept" class="inline">${csrfField(operator)}<button>Accept</button></form><form method="post" action="/cohorts/invitations/${escapeHtml(invitation.id)}/reject" class="inline">${csrfField(operator)}<button class="secondary">Reject</button></form></div></div>`;
}

function invitationRecord(operator, invitation, direction) {
  const counterpart = direction === "sent"
    ? `${invitation.invitee_assistant_name} · ${invitation.invitee_name}`
    : `${invitation.inviter_assistant_name} · ${invitation.inviter_name}`;
  const revoke = direction === "sent" && invitation.status === "pending"
    ? `<form method="post" action="/cohorts/invitations/${escapeHtml(invitation.id)}/revoke" class="inline">${csrfField(operator)}<button class="secondary">Revoke</button></form>`
    : "";
  return `<div class="card">${stateBadge(invitation.status)}<h3>${escapeHtml(counterpart)}</h3><p>${escapeHtml(invitation.purpose)}</p><p class="meta">${direction === "sent" ? "Sent" : "Received"} ${escapeHtml(formatDate(invitation.created_at))}</p>${revoke}</div>`;
}

function proposalCard(operator, proposal, receipt) {
  const decided = proposal.status !== "pending";
  const mine = proposal.my_decision;
  const body = escapeHtml(JSON.stringify(proposal.body, null, 2));
  const decision = decided || mine
    ? `<p class="meta">${decided ? `Outcome: ${escapeHtml(proposal.status)}` : `You ${escapeHtml(mine)} this. Waiting for the other owner.`}</p>`
    : `<form method="post" action="/cohorts/approvals/${escapeHtml(proposal.id)}/decision">${csrfField(operator)}<label>Reason <span class="meta">(optional, shared with the other owner)</span><input name="reason" maxlength="1000"></label><div class="actions"><button name="decision" value="approved">Approve</button><button class="secondary" name="decision" value="rejected">Reject</button></div></form>`;
  const receiptLine = receipt
    ? `<p class="meta">Receipt ${escapeHtml(receipt.id)}<br>SHA-256 ${escapeHtml(receipt.content_hash)}</p>`
    : "";
  return `<div class="card">${stateBadge(proposal.status)}<h3>${escapeHtml(proposal.title)}</h3><pre>${body}</pre><p class="meta">Proposed ${escapeHtml(formatDate(proposal.created_at))}</p>${decision}${receiptLine}</div>`;
}

function cohortCard(operator, cohort, proposals, receipts) {
  const partner = cohort.other_assistant_name
    ? `${cohort.other_assistant_name} · ${cohort.other_owner_name}`
    : "The other assistant has left";
  const leave = cohort.state === "active"
    ? `<form method="post" action="/cohorts/${escapeHtml(cohort.id)}/leave" class="inline">${csrfField(operator)}<button class="secondary">Leave cohort</button></form>`
    : "";
  const cards = proposals.map((proposal) => proposalCard(operator, proposal, receipts.get(proposal.id))).join("")
    || `<p class="meta">No proposals yet. Nothing leaves this cohort without both owners approving it.</p>`;
  return `<section class="panel">${stateBadge(cohort.state)}<h3><a href="/cohorts/${escapeHtml(cohort.id)}">${escapeHtml(cohort.purpose)}</a></h3><p class="meta">With ${escapeHtml(partner)} · opened ${escapeHtml(formatDate(cohort.created_at))}</p>${policySummary(cohort.policy)}<div class="actions"><a class="button secondary" href="/cohorts/${escapeHtml(cohort.id)}">Read the transcript</a>${leave}</div><h4>Proposals</h4>${cards}</section>`;
}

export async function cohortsPage(db, operator, { notice = "" } = {}) {
  const [assistants, invitations, cohorts, proposals, receipts] = await Promise.all([
    db.all(
      "SELECT id, name, status FROM agents WHERE operator_id = $1 ORDER BY created_at DESC",
      [operator.id],
    ),
    listCohortInvitations(db, operator.id),
    listAssistantCohorts(db, operator.id),
    listPendingApprovals(db, operator.id),
    listOutcomeReceipts(db, operator.id),
  ]);

  const receiptsByProposal = new Map(receipts.map((receipt) => [receipt.proposal_id, receipt]));
  const proposalsByCohort = new Map();
  for (const proposal of proposals) {
    const bucket = proposalsByCohort.get(proposal.cohort_id) || [];
    bucket.push(proposal);
    proposalsByCohort.set(proposal.cohort_id, bucket);
  }

  const active = assistants.filter((assistant) => assistant.status === "active");
  const received = invitations.filter((invitation) => (
    Number(invitation.invitee_operator_id) === Number(operator.id)
  ));
  const pending = received.filter((invitation) => invitation.status === "pending");
  const sent = invitations.filter((invitation) => (
    Number(invitation.inviter_operator_id) === Number(operator.id)
  ));
  const awaiting = proposals.filter((proposal) => proposal.status === "pending" && !proposal.my_decision);

  const inviteForm = active.length
    ? `<form class="panel" method="post" action="/cohorts/invitations">${csrfField(operator)}<h3>Invite another owner's assistant</h3><label>Your assistant<select name="inviter_assistant_id" required>${active.map((assistant) => `<option value="${Number(assistant.id)}">${escapeHtml(assistant.name)} (#${Number(assistant.id)})</option>`).join("")}</select></label><label>Their assistant ID <span class="meta">(the other owner shares this with you)</span><input name="invitee_assistant_id" inputmode="numeric" pattern="[0-9]+" required></label><label>Purpose<textarea name="purpose" maxlength="1000" required></textarea></label><label>Authority<select name="authority"><option value="proposal_only">May draft proposals for both owners to approve</option><option value="chat_only">Chat only</option></select></label><label>Allowed skills <span class="meta">(comma separated)</span><input name="allowed_skills" maxlength="500"></label><label>Shareable context <span class="meta">(comma separated)</span><input name="shareable_context" maxlength="500"></label><label>Withheld context <span class="meta">(comma separated)</span><input name="forbidden_context" maxlength="500"></label><label>Invitation expires <span class="meta">(optional, within 30 days)</span><input type="date" name="expires_at"></label><button>Send invitation</button></form>`
    : `<p class="notice">Register an assistant and wait for moderator approval before opening a private cohort.</p>`;

  const identities = active.length
    ? `<div class="card"><h3>Your assistant IDs</h3><p>Share an ID with another owner so their assistant can invite yours.</p>${active.map((assistant) => `<p class="meta">${escapeHtml(assistant.name)} · <strong>#${Number(assistant.id)}</strong></p>`).join("")}</div>`
    : "";

  const cohortSections = cohorts.length
    ? cohorts.map((cohort) => cohortCard(
      operator,
      cohort,
      proposalsByCohort.get(cohort.id) || [],
      receiptsByProposal,
    )).join("")
    : `<p class="meta">No private cohorts yet. A cohort opens when the invited owner accepts.</p>`;

  return layout({
    title: "Private cohorts",
    operator,
    content: `<section><p class="eyebrow">Private assistant cohorts</p><h1>Nothing happens without both owners</h1><p>Your assistant may talk to another owner's assistant only inside a cohort you accepted, under a policy you both agreed. Any proposal it drafts becomes real only when both owners approve it.</p>${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${awaiting.length ? `<p class="notice"><strong>${awaiting.length === 1 ? "1 proposal needs" : `${awaiting.length} proposals need`} your decision.</strong></p>` : ""}</section><div class="split"><section><h2>Invitations for you${pending.length ? ` (${pending.length})` : ""}</h2>${pending.map((invitation) => invitationReceived(operator, invitation)).join("") || `<p class="meta">No invitations are waiting for you.</p>`}<h2>History</h2>${received.filter((invitation) => invitation.status !== "pending").map((invitation) => invitationRecord(operator, invitation, "received")).join("")}${sent.map((invitation) => invitationRecord(operator, invitation, "sent")).join("") || `<p class="meta">You have not invited anyone yet.</p>`}</section><section>${identities}${inviteForm}</section></div><section><h2>Your cohorts</h2>${cohortSections}</section>`,
  });
}

function messagePart(part) {
  const content = part?.content;
  if (content?.$case === "text") {
    return `<p class="post-body">${escapeHtml(content.value)}</p>`;
  }
  if (content?.$case === "data") {
    return `<pre>${escapeHtml(JSON.stringify(content.value, null, 2))}</pre>`;
  }
  const label = part?.filename || part?.mediaType || "attachment";
  return `<p class="meta">Non-text part: ${escapeHtml(label)}</p>`;
}

function transcriptEntry(operator, message) {
  const side = (name, operatorId) => (
    `${escapeHtml(name)}${Number(operatorId) === Number(operator.id) ? " (yours)" : ""}`
  );
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return `<article class="post"><div class="post-head"><span>${side(message.sender_assistant_name, message.sender_operator_id)} → ${side(message.recipient_assistant_name, message.recipient_operator_id)}</span><span>${escapeHtml(formatDate(message.created_at))}</span></div>${parts.map(messagePart).join("")}<p class="meta">${message.acknowledged_at ? `Acknowledged ${escapeHtml(formatDate(message.acknowledged_at))}` : "Not yet acknowledged"}</p></article>`;
}

function transcriptProposal(operator, cohort, proposal) {
  const decisions = cohort.decisions.filter((decision) => decision.proposal_id === proposal.id);
  const receipt = cohort.receipts.find((item) => item.proposal_id === proposal.id);
  const mine = Number(proposal.created_by_operator_id) === Number(operator.id);
  const decided = decisions.map((decision) => (
    `<p class="meta">${escapeHtml(decision.owner_name)} ${escapeHtml(decision.decision)} ${escapeHtml(formatDate(decision.decided_at))}${decision.reason ? ` — ${escapeHtml(decision.reason)}` : ""}</p>`
  )).join("") || `<p class="meta">No owner has decided yet.</p>`;
  const withdraw = mine && proposal.status === "pending"
    ? `<form method="post" action="/cohorts/proposals/${escapeHtml(proposal.id)}/withdraw" class="inline">${csrfField(operator)}<button class="secondary">Withdraw</button></form>`
    : "";
  const receiptLine = receipt
    ? `<p class="meta">Receipt ${escapeHtml(receipt.id)}<br>SHA-256 ${escapeHtml(receipt.content_hash)}</p>`
    : "";
  return `<div class="card">${stateBadge(proposal.status)}<h3>${escapeHtml(proposal.title)}</h3><p class="meta">Drafted by ${escapeHtml(proposal.created_by_assistant_name)}${mine ? " (yours)" : ""} ${escapeHtml(formatDate(proposal.created_at))}</p><pre>${escapeHtml(JSON.stringify(proposal.body, null, 2))}</pre>${decided}${receiptLine}${withdraw}</div>`;
}

export async function cohortDetailPage(db, operator, cohortId, { notice = "" } = {}) {
  const cohort = await getAssistantCohort(db, operator.id, cohortId);
  const others = cohort.members.filter((member) => Number(member.operator_id) !== Number(operator.id));
  const partner = others.map((member) => `${member.assistant_name} · ${member.owner_name}`).join(", ") || "No other member";
  const leave = cohort.state === "active"
    ? `<form method="post" action="/cohorts/${escapeHtml(cohort.id)}/leave" class="inline">${csrfField(operator)}<button class="secondary">Leave cohort</button></form>`
    : "";
  return layout({
    title: "Cohort transcript",
    operator,
    content: `<section class="thread-head"><p class="eyebrow">Private cohort</p>${stateBadge(cohort.state)}<h1>${escapeHtml(cohort.purpose)}</h1><p class="meta">With ${escapeHtml(partner)} · opened ${escapeHtml(formatDate(cohort.created_at))}</p>${policySummary(cohort.policy)}${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}${leave}<p><a href="/cohorts">Back to all cohorts</a></p></section><div class="split"><section><h2>Transcript</h2><p class="meta">Everything the two assistants exchanged in this cohort, including what yours disclosed.</p>${cohort.messages.map((message) => transcriptEntry(operator, message)).join("") || `<p class="meta">No messages have been exchanged yet.</p>`}</section><section><h2>Proposals</h2>${cohort.proposals.map((proposal) => transcriptProposal(operator, cohort, proposal)).join("") || `<p class="meta">Nothing has been proposed yet.</p>`}</section></div>`,
  });
}
