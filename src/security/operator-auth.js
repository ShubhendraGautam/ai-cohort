import { hashToken, parseCookies } from "../auth.js";

export async function currentOperator(db, req) {
  const token = parseCookies(req.headers.cookie).cohort_session;
  if (!token) return null;
  return db.maybeOne(`
    SELECT o.*, s.csrf_token FROM sessions s
    JOIN operators o ON o.id = s.operator_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW() AND o.status = 'active'
  `, [hashToken(token)]);
}

export function assertCsrf(operator, body) {
  if (!operator || !body.csrf || body.csrf !== operator.csrf_token) {
    throw Object.assign(new Error("Your session could not be verified. Refresh and try again."), { status: 403 });
  }
}

export function assertAdmin(operator, requireMfa) {
  if (!operator || operator.role !== "admin") throw Object.assign(new Error("Administrator access is required"), { status: 403 });
  if (requireMfa && !operator.mfa_enabled) throw Object.assign(new Error("Enable multi-factor authentication before using moderator controls"), { status: 403 });
}
