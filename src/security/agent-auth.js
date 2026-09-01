import { verifyAgentRequestSignature } from "../auth.js";

export const AGENT_CLOCK_SKEW_SECONDS = 300;
export const AGENT_REQUESTS_PER_MINUTE = 60;
export const OPERATOR_REQUESTS_PER_MINUTE = 180;

export function operatorRequestLimit() {
  const configured = Number(process.env.OPERATOR_REQUESTS_PER_MINUTE);
  return Number.isFinite(configured) && configured > 0 ? configured : OPERATOR_REQUESTS_PER_MINUTE;
}

// One budget per operator, shared by every agent they run and charged on every
// agent surface. Without it an operator multiplies their footprint by
// registering more agents, which inverts the accountability model C1 rests on:
// the operator, not the agent, is the party that can be suspended.
export async function chargeOperatorBudget(coordinator, operatorId) {
  const rate = await coordinator.rateLimit(`operator:${operatorId}`, operatorRequestLimit(), 60);
  if (!rate.allowed) {
    throw Object.assign(new Error("Operator request rate limit exceeded"), { status: 429, retryAfter: rate.retryAfter });
  }
  return rate;
}

export async function authenticateAgent({ db, coordinator, req, url, rawBody }) {
  const agentId = String(req.headers["x-cohort-agent-id"] || "");
  const timestamp = String(req.headers["x-cohort-timestamp"] || "");
  const nonce = String(req.headers["x-cohort-nonce"] || "");
  const signature = String(req.headers["x-cohort-signature"] || "");
  if (!/^\d+$/.test(agentId) || !/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !signature) {
    throw Object.assign(new Error("Complete signed-agent headers are required"), { status: 401 });
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > AGENT_CLOCK_SKEW_SECONDS) {
    throw Object.assign(new Error("Agent request timestamp is outside the five-minute window"), { status: 401 });
  }
  const agent = await db.maybeOne(`
    SELECT a.*, o.name AS operator_name FROM agents a
    JOIN operators o ON o.id = a.operator_id
    WHERE a.id = $1 AND a.status = 'active' AND o.status = 'active'
  `, [agentId]);
  if (!agent) throw Object.assign(new Error("Approved agent identity not found"), { status: 401 });
  const valid = verifyAgentRequestSignature({
    publicKeyPem: agent.public_key_pem,
    signature,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    timestamp,
    nonce,
    body: rawBody,
  });
  if (!valid) throw Object.assign(new Error("Agent request signature is invalid"), { status: 401 });
  const rate = await coordinator.rateLimit(`agent:${agent.id}`, AGENT_REQUESTS_PER_MINUTE, 60);
  if (!rate.allowed) throw Object.assign(new Error("Agent request rate limit exceeded"), { status: 429, retryAfter: rate.retryAfter });
  // Charged before the nonce is claimed, so a throttled request does not burn
  // one and force the caller to re-sign with a fresh value.
  await chargeOperatorBudget(coordinator, agent.operator_id);
  if (!await coordinator.claimNonce(agent.id, nonce, AGENT_CLOCK_SKEW_SECONDS * 2)) {
    throw Object.assign(new Error("Agent request nonce has already been used"), { status: 409 });
  }
  return { agent, nonce };
}
