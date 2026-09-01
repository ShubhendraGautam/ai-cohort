import {
  acknowledgeCohortMessage,
  createCohortProposal,
  listAssistantInbox,
  withdrawProposalByAgent,
} from "../cohorts/service.js";
import { pruneExpired } from "../db.js";
import { json, parseBody, readRawBody, remoteAddress } from "../http/primitives.js";
import { authenticatedTokenAgent } from "../security/agent-tokens.js";
import { chargeOperatorBudget } from "../security/agent-auth.js";

export async function handleAgentCohortRoutes({ req, res, path, url, db, coordinator, agentTokenSecret, retentionDays }) {
  if (!path.startsWith("/agent/v1/")) return false;
  const { agent } = await authenticatedTokenAgent(db, req, agentTokenSecret);
  const rate = await coordinator.rateLimit(
    `agent-control:${agent.id}:${remoteAddress(req)}`,
    120,
    60,
  );
  if (!rate.allowed) {
    json(res, 429, { error: "Agent cohort rate limit exceeded" }, { "retry-after": String(rate.retryAfter) });
    return true;
  }
  await chargeOperatorBudget(coordinator, agent.operator_id);

  if (req.method === "GET" && path === "/agent/v1/inbox") {
    await pruneExpired(db, retentionDays);
    const inbox = await listAssistantInbox(db, agent.id, {
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit"),
    });
    json(res, 200, inbox);
    return true;
  }

  let match = path.match(/^\/agent\/v1\/inbox\/([0-9a-f-]{36})\/ack$/);
  if (req.method === "POST" && match) {
    await acknowledgeCohortMessage(db, agent.id, match[1]);
    json(res, 200, { acknowledged: true });
    return true;
  }

  match = path.match(/^\/agent\/v1\/cohorts\/([0-9a-f-]{36})\/proposals$/);
  if (req.method === "POST" && match) {
    const body = parseBody(await readRawBody(req), req.headers["content-type"] || "");
    const proposal = await createCohortProposal(db, agent.id, match[1], body);
    json(res, 201, { proposal }, { location: `/control/v1/approvals/${proposal.id}` });
    return true;
  }

  match = path.match(/^\/agent\/v1\/proposals\/([0-9a-f-]{36})\/withdraw$/);
  if (req.method === "POST" && match) {
    const proposal = await withdrawProposalByAgent(db, agent.id, match[1]);
    json(res, 200, { proposal });
    return true;
  }

  json(res, 404, { error: "Agent cohort endpoint not found" });
  return true;
}
