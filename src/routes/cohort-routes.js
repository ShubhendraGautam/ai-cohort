import {
  createCohortInvitation,
  decideCohortInvitation,
  decideProposal,
  leaveAssistantCohort,
  revokeCohortInvitation,
  withdrawProposalByOperator,
} from "../cohorts/service.js";
import { redirect, send, webBody } from "../http/primitives.js";
import { cohortDetailPage, cohortsPage } from "../pages/cohort-pages.js";
import { assertCsrf } from "../security/operator-auth.js";

const PRIVATE = { "cache-control": "private, no-store" };

function commaList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function consentBody(req, operator) {
  if (!operator) throw Object.assign(new Error("Sign in first"), { status: 401 });
  const body = await webBody(req);
  assertCsrf(operator, body);
  return body;
}

export async function handleCohortRoutes(context) {
  const { req, res, path, db, operator } = context;
  if (path !== "/cohorts" && !path.startsWith("/cohorts/")) return false;

  if (req.method === "GET" && path === "/cohorts") {
    if (!operator) redirect(res, "/login");
    else send(res, await cohortsPage(db, operator), PRIVATE);
    return true;
  }

  if (req.method === "POST" && path === "/cohorts/invitations") {
    const body = await consentBody(req, operator);
    const invitation = await createCohortInvitation(db, operator.id, {
      inviterAssistantId: body.inviter_assistant_id,
      inviteeAssistantId: body.invitee_assistant_id,
      purpose: body.purpose,
      expiresAt: body.expires_at || undefined,
      policy: {
        authority: body.authority || "proposal_only",
        allowedSkills: commaList(body.allowed_skills),
        shareableContext: commaList(body.shareable_context),
        forbiddenContext: commaList(body.forbidden_context),
      },
    });
    send(res, await cohortsPage(db, operator, {
      notice: `Invitation sent. The cohort opens only if the other owner accepts it before ${new Date(invitation.expires_at).toISOString().slice(0, 10)}.`,
    }), PRIVATE);
    return true;
  }

  let match = path.match(/^\/cohorts\/invitations\/([0-9a-f-]{36})\/revoke$/);
  if (req.method === "POST" && match) {
    await consentBody(req, operator);
    await revokeCohortInvitation(db, operator.id, match[1]);
    send(res, await cohortsPage(db, operator, {
      notice: "Invitation revoked. It can no longer be accepted.",
    }), PRIVATE);
    return true;
  }

  match = path.match(/^\/cohorts\/proposals\/([0-9a-f-]{36})\/withdraw$/);
  if (req.method === "POST" && match) {
    await consentBody(req, operator);
    const proposal = await withdrawProposalByOperator(db, operator.id, match[1]);
    send(res, await cohortDetailPage(db, operator, proposal.cohort_id, {
      notice: "Proposal withdrawn. No owner decision can be recorded against it.",
    }), PRIVATE);
    return true;
  }

  match = path.match(/^\/cohorts\/invitations\/([0-9a-f-]{36})\/(accept|reject)$/);
  if (req.method === "POST" && match) {
    await consentBody(req, operator);
    const decision = match[2] === "accept" ? "accepted" : "rejected";
    await decideCohortInvitation(db, operator.id, match[1], decision);
    send(res, await cohortsPage(db, operator, {
      notice: decision === "accepted"
        ? "Cohort opened. Both assistants may now exchange messages under the agreed policy."
        : "Invitation rejected. No cohort was created and no messages can be exchanged.",
    }), PRIVATE);
    return true;
  }

  match = path.match(/^\/cohorts\/approvals\/([0-9a-f-]{36})\/decision$/);
  if (req.method === "POST" && match) {
    const body = await consentBody(req, operator);
    const result = await decideProposal(db, operator.id, match[1], String(body.decision || ""), body.reason);
    const notice = result.proposal.status === "approved"
      ? "Both owners approved. An outcome receipt now records what was agreed."
      : result.proposal.status === "rejected"
        ? "Proposal rejected. Nothing was carried out."
        : "Your decision is recorded. The proposal waits for the other owner.";
    send(res, await cohortsPage(db, operator, { notice }), PRIVATE);
    return true;
  }

  match = path.match(/^\/cohorts\/([0-9a-f-]{36})$/);
  if (req.method === "GET" && match) {
    if (!operator) redirect(res, "/login");
    else send(res, await cohortDetailPage(db, operator, match[1]), PRIVATE);
    return true;
  }

  match = path.match(/^\/cohorts\/([0-9a-f-]{36})\/leave$/);
  if (req.method === "POST" && match) {
    await consentBody(req, operator);
    const result = await leaveAssistantCohort(db, operator.id, match[1]);
    send(res, await cohortsPage(db, operator, {
      notice: result.state === "closed"
        ? "You left the cohort and it is now closed. No further messages can be exchanged."
        : "You left the cohort.",
    }), PRIVATE);
    return true;
  }

  return false;
}
