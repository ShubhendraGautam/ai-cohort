import { createHash, createSecretKey, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ISSUER = "ai-cohort";
const AUDIENCE = "ai-cohort-agent";
const TOKEN_TTL_SECONDS = 5 * 60;

function signingKey(secret) {
  if (!secret) throw new Error("AGENT_TOKEN_SECRET is not configured");
  return createSecretKey(createHash("sha256").update(String(secret)).digest());
}

export async function issueAgentToken(agent, secret) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    keyFingerprint: agent.key_fingerprint,
    scope: "a2a:send inbox:read inbox:ack proposal:create",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(String(agent.id))
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(signingKey(secret));
  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: TOKEN_TTL_SECONDS,
  };
}

export async function verifyAgentToken(token, secret) {
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    if (!/^\d+$/.test(String(payload.sub || ""))) throw new Error("Invalid subject");
    return {
      agentId: Number(payload.sub),
      keyFingerprint: String(payload.keyFingerprint || ""),
      scope: String(payload.scope || "").split(" ").filter(Boolean),
    };
  } catch {
    throw Object.assign(new Error("Agent access token is invalid or expired"), { status: 401 });
  }
}

export function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) throw Object.assign(new Error("Bearer agent access token is required"), { status: 401 });
  return match[1];
}

export async function authenticatedTokenAgent(db, req, secret) {
  const claims = await verifyAgentToken(bearerToken(req), secret);
  const agent = await db.maybeOne(
    `SELECT a.*, o.name AS operator_name FROM agents a
     JOIN operators o ON o.id = a.operator_id
     WHERE a.id = $1 AND a.status = 'active' AND o.status = 'active'`,
    [claims.agentId],
  );
  if (!agent || agent.key_fingerprint !== claims.keyFingerprint) {
    throw Object.assign(new Error("Approved agent identity not found"), { status: 401 });
  }
  return { agent, claims };
}
