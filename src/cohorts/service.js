import { createHash, randomUUID } from "node:crypto";

export const PRIVATE_COHORT_EXTENSION = "https://ai-cohort.dev/extensions/private-cohort/v1";

const AUTHORITIES = new Set(["chat_only", "proposal_only"]);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function stringList(value, name, maximum = 20) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw httpError(400, `${name} must be an array with at most ${maximum} entries`);
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export function normalizeCohortPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "Policy must be a JSON object");
  }
  const authority = String(value.authority || "proposal_only");
  if (!AUTHORITIES.has(authority)) {
    throw httpError(400, "Authority must be chat_only or proposal_only");
  }
  return {
    allowedSkills: stringList(value.allowedSkills, "allowedSkills"),
    shareableContext: stringList(value.shareableContext, "shareableContext"),
    forbiddenContext: stringList(value.forbiddenContext, "forbiddenContext"),
    authority,
  };
}

function parseExpiry(value) {
  const expiry = value ? new Date(value) : new Date(Date.now() + 7 * 86_400_000);
  if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
    throw httpError(400, "Invitation expiry must be in the future");
  }
  if (expiry.getTime() > Date.now() + 30 * 86_400_000) {
    throw httpError(400, "Invitation expiry cannot exceed 30 days");
  }
  return expiry.toISOString();
}

export async function createCohortInvitation(db, operatorId, input) {
  const inviterAgentId = Number(input.inviterAssistantId);
  const inviteeAgentId = Number(input.inviteeAssistantId);
  if (!Number.isInteger(inviterAgentId) || !Number.isInteger(inviteeAgentId)) {
    throw httpError(400, "Valid inviterAssistantId and inviteeAssistantId are required");
  }
  const purpose = String(input.purpose || "").trim();
  if (!purpose || purpose.length > 1_000) throw httpError(400, "Purpose is required and must be at most 1000 characters");
  const agents = await db.all(
    "SELECT id, operator_id FROM agents WHERE (id = $1 OR id = $2) AND status = 'active'",
    [inviterAgentId, inviteeAgentId],
  );
  const inviter = agents.find((agent) => Number(agent.id) === inviterAgentId);
  const invitee = agents.find((agent) => Number(agent.id) === inviteeAgentId);
  if (!inviter || Number(inviter.operator_id) !== Number(operatorId)) {
    throw httpError(403, "The inviting assistant must be active and owned by you");
  }
  if (!invitee) throw httpError(404, "The invited assistant is not available");
  if (Number(invitee.operator_id) === Number(operatorId)) {
    throw httpError(400, "A private cohort requires assistants from different owners");
  }
  const existing = await db.maybeOne(
    `SELECT id FROM assistant_cohort_invitations
     WHERE inviter_agent_id = $1 AND invitee_agent_id = $2
       AND status = 'pending' AND expires_at > NOW()`,
    [inviterAgentId, inviteeAgentId],
  );
  if (existing) throw httpError(409, "A pending invitation already exists for these assistants");

  return db.one(
    `INSERT INTO assistant_cohort_invitations
      (id, inviter_operator_id, invitee_operator_id, inviter_agent_id, invitee_agent_id, purpose, policy, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING *`,
    [
      randomUUID(),
      operatorId,
      invitee.operator_id,
      inviterAgentId,
      inviteeAgentId,
      purpose,
      JSON.stringify(normalizeCohortPolicy(input.policy)),
      parseExpiry(input.expiresAt),
    ],
  );
}

export async function listCohortInvitations(db, operatorId) {
  await db.query(
    "UPDATE assistant_cohort_invitations SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()",
  );
  return db.all(
    `SELECT i.*, ia.name AS inviter_assistant_name, io.name AS inviter_name,
       ea.name AS invitee_assistant_name, eo.name AS invitee_name
     FROM assistant_cohort_invitations i
     JOIN agents ia ON ia.id = i.inviter_agent_id
     JOIN operators io ON io.id = i.inviter_operator_id
     JOIN agents ea ON ea.id = i.invitee_agent_id
     JOIN operators eo ON eo.id = i.invitee_operator_id
     WHERE i.inviter_operator_id = $1 OR i.invitee_operator_id = $1
     ORDER BY i.created_at DESC`,
    [operatorId],
  );
}

export async function decideCohortInvitation(db, operatorId, invitationId, decision) {
  if (!["accepted", "rejected"].includes(decision)) throw httpError(400, "Decision must be accepted or rejected");
  return db.transaction(async (client) => {
    const invitation = await db.maybeOne(
      "SELECT * FROM assistant_cohort_invitations WHERE id = $1 FOR UPDATE",
      [invitationId],
      client,
    );
    if (!invitation || Number(invitation.invitee_operator_id) !== Number(operatorId)) {
      throw httpError(404, "Pending invitation not found");
    }
    if (invitation.status !== "pending") throw httpError(409, "Invitation has already been decided");
    if (new Date(invitation.expires_at) <= new Date()) {
      throw httpError(409, "Invitation has expired");
    }
    const activeAgents = await db.one(
      `SELECT COUNT(*)::int AS count FROM agents a
       JOIN operators o ON o.id = a.operator_id
       WHERE (a.id = $1 OR a.id = $2)
         AND a.status = 'active' AND o.status = 'active'`,
      [invitation.inviter_agent_id, invitation.invitee_agent_id],
      client,
    );
    if (activeAgents.count !== 2) throw httpError(409, "Both assistants and owners must remain active");
    await db.query(
      "UPDATE assistant_cohort_invitations SET status = $1, responded_at = NOW() WHERE id = $2",
      [decision, invitationId],
      client,
    );
    if (decision === "rejected") return { invitation: { ...invitation, status: decision }, cohort: null };

    const cohort = await db.one(
      `INSERT INTO assistant_cohorts (id, invitation_id, purpose, policy)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
      [randomUUID(), invitation.id, invitation.purpose, JSON.stringify(invitation.policy)],
      client,
    );
    await db.query(
      `INSERT INTO assistant_cohort_members (cohort_id, agent_id, operator_id)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [
        cohort.id,
        invitation.inviter_agent_id,
        invitation.inviter_operator_id,
        invitation.invitee_agent_id,
        invitation.invitee_operator_id,
      ],
      client,
    );
    return { invitation: { ...invitation, status: decision }, cohort };
  });
}

export async function listAssistantCohorts(db, operatorId) {
  return db.all(
    `SELECT c.*, mine.agent_id AS my_assistant_id,
       other.agent_id AS other_assistant_id, a.name AS other_assistant_name,
       o.name AS other_owner_name
     FROM assistant_cohorts c
     JOIN assistant_cohort_members mine
       ON mine.cohort_id = c.id AND mine.operator_id = $1
     LEFT JOIN assistant_cohort_members other
       ON other.cohort_id = c.id AND other.operator_id <> $1
     LEFT JOIN agents a ON a.id = other.agent_id
     LEFT JOIN operators o ON o.id = other.operator_id
     ORDER BY c.created_at DESC`,
    [operatorId],
  );
}

export async function getAssistantCohort(db, operatorId, cohortId) {
  const cohort = await db.maybeOne(
    `SELECT c.* FROM assistant_cohorts c
     JOIN assistant_cohort_members m ON m.cohort_id = c.id
     WHERE c.id = $1 AND m.operator_id = $2`,
    [cohortId, operatorId],
  );
  if (!cohort) throw httpError(404, "Cohort not found");
  const [members, proposals, messages, receipts] = await Promise.all([
    db.all(
      `SELECT m.agent_id, m.operator_id, m.status, m.joined_at, m.left_at,
         a.name AS assistant_name, o.name AS owner_name
       FROM assistant_cohort_members m
       JOIN agents a ON a.id = m.agent_id
       JOIN operators o ON o.id = m.operator_id
       WHERE m.cohort_id = $1 ORDER BY m.joined_at`,
      [cohortId],
    ),
    db.all(
      `SELECT p.*, a.name AS created_by_assistant_name, a.operator_id AS created_by_operator_id
       FROM assistant_cohort_proposals p
       JOIN agents a ON a.id = p.created_by_agent_id
       WHERE p.cohort_id = $1 ORDER BY p.created_at DESC`,
      [cohortId],
    ),
    db.all(
      `SELECT m.*, sender.name AS sender_assistant_name,
         sender.operator_id AS sender_operator_id, recipient.name AS recipient_assistant_name,
         recipient.operator_id AS recipient_operator_id
       FROM assistant_cohort_messages m
       JOIN agents sender ON sender.id = m.sender_agent_id
       JOIN agents recipient ON recipient.id = m.recipient_agent_id
       WHERE m.cohort_id = $1 ORDER BY m.created_at, m.id`,
      [cohortId],
    ),
    db.all(
      "SELECT * FROM assistant_outcome_receipts WHERE cohort_id = $1 ORDER BY created_at DESC",
      [cohortId],
    ),
  ]);
  const decisions = proposals.length
    ? await db.all(
      `SELECT d.*, o.name AS owner_name FROM assistant_proposal_decisions d
       JOIN operators o ON o.id = d.operator_id
       JOIN assistant_cohort_proposals p ON p.id = d.proposal_id
       WHERE p.cohort_id = $1 ORDER BY d.decided_at`,
      [cohortId],
    )
    : [];
  return { ...cohort, members, proposals, messages, receipts, decisions };
}

export async function revokeCohortInvitation(db, operatorId, invitationId) {
  return db.transaction(async (client) => {
    const invitation = await db.maybeOne(
      "SELECT * FROM assistant_cohort_invitations WHERE id = $1 FOR UPDATE",
      [invitationId],
      client,
    );
    if (!invitation || Number(invitation.inviter_operator_id) !== Number(operatorId)) {
      throw httpError(404, "Invitation not found");
    }
    if (invitation.status !== "pending") throw httpError(409, "Invitation has already been decided");
    await db.query(
      "UPDATE assistant_cohort_invitations SET status = 'revoked', responded_at = NOW() WHERE id = $1",
      [invitationId],
      client,
    );
    return { ...invitation, status: "revoked" };
  });
}

async function withdrawPendingProposal(db, proposalId, authorize) {
  return db.transaction(async (client) => {
    const proposal = await db.maybeOne(
      `SELECT p.*, a.operator_id AS created_by_operator_id
       FROM assistant_cohort_proposals p
       JOIN agents a ON a.id = p.created_by_agent_id
       WHERE p.id = $1 FOR UPDATE`,
      [proposalId],
      client,
    );
    if (!proposal || !authorize(proposal)) throw httpError(404, "Proposal not found");
    if (proposal.status !== "pending") throw httpError(409, "Proposal has already reached a final decision");
    await db.query(
      "UPDATE assistant_cohort_proposals SET status = 'withdrawn', decided_at = NOW() WHERE id = $1",
      [proposalId],
      client,
    );
    return { ...proposal, status: "withdrawn" };
  });
}

export async function withdrawProposalByAgent(db, agentId, proposalId) {
  return withdrawPendingProposal(db, proposalId, (proposal) => (
    Number(proposal.created_by_agent_id) === Number(agentId)
  ));
}

export async function withdrawProposalByOperator(db, operatorId, proposalId) {
  return withdrawPendingProposal(db, proposalId, (proposal) => (
    Number(proposal.created_by_operator_id) === Number(operatorId)
  ));
}

export async function closeCohortsForOperator(db, operatorId, client) {
  await db.query(
    `UPDATE assistant_cohort_members SET status = 'left', left_at = NOW()
     WHERE operator_id = $1 AND status = 'active'`,
    [operatorId],
    client,
  );
  await db.query(
    `UPDATE assistant_cohorts SET state = 'closed', closed_at = NOW()
     WHERE state = 'active' AND id IN (
       SELECT cohort_id FROM assistant_cohort_members
       WHERE operator_id = $1
     )`,
    [operatorId],
    client,
  );
  await db.query(
    `UPDATE assistant_cohort_invitations SET status = 'revoked', responded_at = NOW()
     WHERE status = 'pending' AND (inviter_operator_id = $1 OR invitee_operator_id = $1)`,
    [operatorId],
    client,
  );
}

export async function leaveAssistantCohort(db, operatorId, cohortId) {
  return db.transaction(async (client) => {
    const membership = await db.maybeOne(
      `SELECT m.status, c.state FROM assistant_cohort_members m
       JOIN assistant_cohorts c ON c.id = m.cohort_id
       WHERE m.cohort_id = $1 AND m.operator_id = $2
       FOR UPDATE`,
      [cohortId, operatorId],
      client,
    );
    if (!membership) throw httpError(404, "Cohort not found");
    if (membership.status !== "active" || membership.state !== "active") {
      throw httpError(409, "Cohort membership is already inactive");
    }
    await db.query(
      `UPDATE assistant_cohort_members
       SET status = 'left', left_at = NOW()
       WHERE cohort_id = $1 AND operator_id = $2`,
      [cohortId, operatorId],
      client,
    );
    const remaining = await db.one(
      "SELECT COUNT(*)::int AS count FROM assistant_cohort_members WHERE cohort_id = $1 AND status = 'active'",
      [cohortId],
      client,
    );
    if (remaining.count < 2) {
      await db.query(
        "UPDATE assistant_cohorts SET state = 'closed', closed_at = NOW() WHERE id = $1",
        [cohortId],
        client,
      );
    }
    return { cohortId, state: remaining.count < 2 ? "closed" : "active" };
  });
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!value.at || !value.id || Number.isNaN(new Date(value.at).getTime())) throw new Error();
    return value;
  } catch {
    throw httpError(400, "Inbox cursor is invalid");
  }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ at: row.created_at, id: row.id })).toString("base64url");
}

export async function storeCohortMessage(db, senderAgentId, message) {
  if (!message || !message.messageId || !Array.isArray(message.parts) || !message.parts.length) {
    throw httpError(400, "A2A messageId and at least one part are required");
  }
  if (Buffer.byteLength(JSON.stringify(message.parts)) > 48 * 1024) {
    throw httpError(413, "Message parts are too large");
  }
  const extension = message.metadata?.[PRIVATE_COHORT_EXTENSION];
  const cohortId = String(extension?.cohortId || "");
  const recipientAgentId = Number(extension?.recipientAssistantId);
  if (!cohortId || !Number.isInteger(recipientAgentId)) {
    throw httpError(400, "Private cohort metadata must include cohortId and recipientAssistantId");
  }
  if (!message.extensions?.includes(PRIVATE_COHORT_EXTENSION)) {
    throw httpError(400, "Private cohort extension must be declared on the message");
  }
  if (Array.isArray(extension.contextGrantIds) && extension.contextGrantIds.length) {
    throw httpError(400, "Context grants are not enabled in this release");
  }

  return db.transaction(async (client) => {
    const prior = await db.maybeOne(
      "SELECT * FROM assistant_cohort_messages WHERE id = $1",
      [message.messageId],
      client,
    );
    if (prior) {
      if (Number(prior.sender_agent_id) !== Number(senderAgentId) || prior.cohort_id !== cohortId) {
        throw httpError(409, "Message identifier is already in use");
      }
      return prior;
    }
    const membership = await db.all(
      `SELECT c.state, m.agent_id, m.status,
         a.status AS agent_status, o.status AS operator_status
       FROM assistant_cohorts c
       JOIN assistant_cohort_members m ON m.cohort_id = c.id
       JOIN agents a ON a.id = m.agent_id
       JOIN operators o ON o.id = m.operator_id
       WHERE c.id = $1 AND (m.agent_id = $2 OR m.agent_id = $3)
       FOR UPDATE`,
      [cohortId, senderAgentId, recipientAgentId],
      client,
    );
    if (
      membership.length !== 2
      || membership.some((row) => (
        row.state !== "active"
        || row.status !== "active"
        || row.agent_status !== "active"
        || row.operator_status !== "active"
      ))
    ) {
      throw httpError(403, "Both assistants must be active members of this cohort");
    }
    return db.one(
      `INSERT INTO assistant_cohort_messages
        (id, cohort_id, sender_agent_id, recipient_agent_id, context_id, task_id, parts, metadata, extensions)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
       RETURNING *`,
      [
        message.messageId,
        cohortId,
        senderAgentId,
        recipientAgentId,
        message.contextId || randomUUID(),
        message.taskId || null,
        JSON.stringify(message.parts),
        JSON.stringify(message.metadata || {}),
        JSON.stringify(message.extensions || []),
      ],
      client,
    );
  });
}

export async function listAssistantInbox(db, agentId, { cursor, limit = 50 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const after = decodeCursor(cursor);
  const params = [agentId];
  let boundary = "";
  if (after) {
    params.push(after.at, after.id);
    boundary = "AND (m.created_at > $2 OR (m.created_at = $2 AND m.id > $3))";
  }
  params.push(size + 1);
  const rows = await db.all(
    `SELECT m.*, a.name AS sender_assistant_name
     FROM assistant_cohort_messages m
     JOIN agents a ON a.id = m.sender_agent_id
     WHERE m.recipient_agent_id = $1 ${boundary}
     ORDER BY m.created_at, m.id
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > size;
  const items = rows.slice(0, size);
  return {
    messages: items,
    nextCursor: hasMore ? encodeCursor(items.at(-1)) : null,
  };
}

export async function acknowledgeCohortMessage(db, agentId, messageId) {
  const result = await db.query(
    `UPDATE assistant_cohort_messages SET acknowledged_at = COALESCE(acknowledged_at, NOW())
     WHERE id = $1 AND recipient_agent_id = $2`,
    [messageId, agentId],
  );
  if (!result.rowCount) throw httpError(404, "Inbox message not found");
}

export async function createCohortProposal(db, agentId, cohortId, input) {
  const title = String(input.title || "").trim();
  if (!title || title.length > 200) throw httpError(400, "Proposal title is required and must be at most 200 characters");
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw httpError(400, "Proposal body must be a JSON object");
  }
  if (Buffer.byteLength(JSON.stringify(input.body)) > 32 * 1024) throw httpError(413, "Proposal body is too large");
  const cohort = await db.maybeOne(
    `SELECT c.* FROM assistant_cohorts c
     JOIN assistant_cohort_members m ON m.cohort_id = c.id
     WHERE c.id = $1 AND c.state = 'active' AND m.agent_id = $2 AND m.status = 'active'`,
    [cohortId, agentId],
  );
  if (!cohort) throw httpError(404, "Active cohort not found");
  if (cohort.policy?.authority !== "proposal_only") {
    throw httpError(403, "This cohort is limited to chat");
  }
  return db.one(
    `INSERT INTO assistant_cohort_proposals (id, cohort_id, created_by_agent_id, title, body)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [randomUUID(), cohortId, agentId, title, JSON.stringify(input.body)],
  );
}

export async function listPendingApprovals(db, operatorId) {
  return db.all(
    `SELECT DISTINCT p.*, c.purpose AS cohort_purpose,
       d.decision AS my_decision, d.reason AS my_reason
     FROM assistant_cohort_proposals p
     JOIN assistant_cohorts c ON c.id = p.cohort_id
     JOIN assistant_cohort_members m ON m.cohort_id = c.id
     LEFT JOIN assistant_proposal_decisions d
       ON d.proposal_id = p.id AND d.operator_id = $1
     WHERE m.operator_id = $1
     ORDER BY p.created_at DESC`,
    [operatorId],
  );
}

export async function listOutcomeReceipts(db, operatorId) {
  return db.all(
    `SELECT r.* FROM assistant_outcome_receipts r
     JOIN assistant_cohort_members m ON m.cohort_id = r.cohort_id AND m.operator_id = $1
     ORDER BY r.created_at DESC`,
    [operatorId],
  );
}

export async function decideProposal(db, operatorId, proposalId, decision, reason = null) {
  if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Decision must be approved or rejected");
  return db.transaction(async (client) => {
    const proposal = await db.maybeOne(
      `SELECT p.* FROM assistant_cohort_proposals p
       JOIN assistant_cohort_members m ON m.cohort_id = p.cohort_id
       WHERE p.id = $1 AND m.operator_id = $2
       FOR UPDATE`,
      [proposalId, operatorId],
      client,
    );
    if (!proposal) throw httpError(404, "Proposal not found");
    if (proposal.status !== "pending") throw httpError(409, "Proposal has already reached a final decision");
    const prior = await db.maybeOne(
      "SELECT decision FROM assistant_proposal_decisions WHERE proposal_id = $1 AND operator_id = $2",
      [proposalId, operatorId],
      client,
    );
    if (prior) throw httpError(409, "Your decision is already recorded");
    await db.query(
      `INSERT INTO assistant_proposal_decisions (proposal_id, operator_id, decision, reason)
       VALUES ($1, $2, $3, $4)`,
      [proposalId, operatorId, decision, reason ? String(reason).slice(0, 1_000) : null],
      client,
    );
    const [members, decisions] = await Promise.all([
      db.all(
        "SELECT DISTINCT operator_id FROM assistant_cohort_members WHERE cohort_id = $1 AND status = 'active'",
        [proposal.cohort_id],
        client,
      ),
      db.all(
        "SELECT operator_id, decision, reason, decided_at FROM assistant_proposal_decisions WHERE proposal_id = $1 ORDER BY operator_id",
        [proposalId],
        client,
      ),
    ]);
    let status = "pending";
    if (decisions.some((item) => item.decision === "rejected")) status = "rejected";
    else if (decisions.length === members.length) status = "approved";
    if (status !== "pending") {
      await db.query(
        "UPDATE assistant_cohort_proposals SET status = $1, decided_at = NOW() WHERE id = $2",
        [status, proposalId],
        client,
      );
    }
    let receipt = null;
    if (status === "approved") {
      const body = {
        proposalId,
        cohortId: proposal.cohort_id,
        title: proposal.title,
        proposal: proposal.body,
        decisions,
      };
      const serialized = JSON.stringify(body);
      receipt = await db.one(
        `INSERT INTO assistant_outcome_receipts
          (id, proposal_id, cohort_id, body, content_hash)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
        [randomUUID(), proposalId, proposal.cohort_id, serialized, createHash("sha256").update(serialized).digest("hex")],
        client,
      );
    }
    return { proposal: { ...proposal, status }, decisions, receipt };
  });
}
