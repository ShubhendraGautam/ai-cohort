import {
  createCohortInvitation,
  decideCohortInvitation,
  decideProposal,
  getAssistantCohort,
  leaveAssistantCohort,
  listAssistantCohorts,
  listCohortInvitations,
  listPendingApprovals,
  revokeCohortInvitation,
  withdrawProposalByOperator,
} from "../cohorts/service.js";
import { json, parseBody, readRawBody } from "../http/primitives.js";
import { assertCsrf } from "../security/operator-auth.js";

function requireOperator(operator) {
  if (!operator) throw Object.assign(new Error("Operator sign-in is required"), { status: 401 });
}

async function controlBody(req, operator) {
  const body = parseBody(await readRawBody(req), req.headers["content-type"] || "");
  assertCsrf(operator, { csrf: req.headers["x-csrf-token"] || body.csrf });
  return body;
}

export async function handleControlApiRoutes({ req, res, path, db, operator }) {
  if (!path.startsWith("/control/v1/")) return false;
  requireOperator(operator);

  if (req.method === "GET" && path === "/control/v1/assistants") {
    const assistants = await db.all(
      `SELECT id, name, purpose, key_fingerprint, status, created_at
       FROM agents WHERE operator_id = $1 ORDER BY created_at DESC`,
      [operator.id],
    );
    json(res, 200, { assistants });
    return true;
  }
  if (req.method === "GET" && path === "/control/v1/cohort-invitations") {
    json(res, 200, { invitations: await listCohortInvitations(db, operator.id) });
    return true;
  }
  if (req.method === "POST" && path === "/control/v1/cohort-invitations") {
    const body = await controlBody(req, operator);
    const invitation = await createCohortInvitation(db, operator.id, body);
    json(res, 201, { invitation }, { location: `/control/v1/cohort-invitations/${invitation.id}` });
    return true;
  }

  let match = path.match(/^\/control\/v1\/cohort-invitations\/([0-9a-f-]{36})\/revoke$/);
  if (req.method === "POST" && match) {
    await controlBody(req, operator);
    json(res, 200, { invitation: await revokeCohortInvitation(db, operator.id, match[1]) });
    return true;
  }

  match = path.match(/^\/control\/v1\/proposals\/([0-9a-f-]{36})\/withdraw$/);
  if (req.method === "POST" && match) {
    await controlBody(req, operator);
    json(res, 200, { proposal: await withdrawProposalByOperator(db, operator.id, match[1]) });
    return true;
  }

  match = path.match(/^\/control\/v1\/cohort-invitations\/([0-9a-f-]{36})\/(accept|reject)$/);
  if (req.method === "POST" && match) {
    await controlBody(req, operator);
    const result = await decideCohortInvitation(
      db,
      operator.id,
      match[1],
      match[2] === "accept" ? "accepted" : "rejected",
    );
    json(res, 200, result);
    return true;
  }

  if (req.method === "GET" && path === "/control/v1/cohorts") {
    json(res, 200, { cohorts: await listAssistantCohorts(db, operator.id) });
    return true;
  }
  match = path.match(/^\/control\/v1\/cohorts\/([0-9a-f-]{36})$/);
  if (req.method === "GET" && match) {
    json(res, 200, { cohort: await getAssistantCohort(db, operator.id, match[1]) });
    return true;
  }
  match = path.match(/^\/control\/v1\/cohorts\/([0-9a-f-]{36})\/leave$/);
  if (req.method === "POST" && match) {
    await controlBody(req, operator);
    json(res, 200, await leaveAssistantCohort(db, operator.id, match[1]));
    return true;
  }
  if (req.method === "GET" && path === "/control/v1/approvals") {
    json(res, 200, { proposals: await listPendingApprovals(db, operator.id) });
    return true;
  }
  match = path.match(/^\/control\/v1\/approvals\/([0-9a-f-]{36})\/decision$/);
  if (req.method === "POST" && match) {
    const body = await controlBody(req, operator);
    const result = await decideProposal(db, operator.id, match[1], String(body.decision || ""), body.reason);
    json(res, 200, result);
    return true;
  }

  json(res, 404, { error: "Control endpoint not found" });
  return true;
}
