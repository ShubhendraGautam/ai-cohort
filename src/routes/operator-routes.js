import { createHash } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  hashToken,
  parseCookies,
  randomToken,
  verifyPassword,
  verifyTotp,
} from "../auth.js";
import { createAgent, createSession, securityEvent } from "../db.js";
import { redirect, remoteAddress, required, send, webBody } from "../http/primitives.js";
import { dashboardPage, loginPage, passwordRotationPage } from "../pages/operator-pages.js";
import { assertCsrf } from "../security/operator-auth.js";

export async function handleOperatorRoutes(context) {
  const { req, res, path, db, coordinator, operator, encryptionKey, secureCookies } = context;

  if (req.method === "GET" && path === "/login") {
    if (operator) redirect(res, "/dashboard");
    else send(res, loginPage());
    return true;
  }
  if (req.method === "POST" && path === "/login") {
    const address = remoteAddress(req);
    const ipRate = await coordinator.rateLimit(`login-ip:${address}`, 15, 15 * 60);
    if (!ipRate.allowed) {
      send(res, { ...loginPage("Too many sign-in attempts. Try again later."), status: 429 }, { "retry-after": String(ipRate.retryAfter) });
      return true;
    }
    const body = await webBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const accountKey = createHash("sha256").update(email).digest("hex");
    const accountRate = await coordinator.rateLimit(`login-account:${accountKey}`, 10, 15 * 60);
    if (!accountRate.allowed) {
      send(res, { ...loginPage("Too many sign-in attempts. Try again later."), status: 429 }, { "retry-after": String(accountRate.retryAfter) });
      return true;
    }
    const found = await db.maybeOne("SELECT * FROM operators WHERE email = $1 AND status = 'active'", [email]);
    let accepted = Boolean(found && verifyPassword(String(body.password || ""), found.password_hash));
    let mfaMethod = null;
    if (accepted && found.mfa_enabled) {
      const authCode = String(body.auth_code || "").trim();
      if (encryptionKey && /^\d{6}$/.test(authCode) && verifyTotp(decryptSecret(found.mfa_secret_ciphertext, encryptionKey), authCode)) {
        mfaMethod = "totp";
      } else if (authCode) {
        const recoveryHash = hashToken(authCode);
        const consumed = await db.transaction(async (client) => {
          const locked = await db.maybeOne("SELECT mfa_recovery_hashes FROM operators WHERE id = $1 FOR UPDATE", [found.id], client);
          const hashes = Array.isArray(locked?.mfa_recovery_hashes) ? locked.mfa_recovery_hashes : [];
          if (!hashes.includes(recoveryHash)) return false;
          await db.query("UPDATE operators SET mfa_recovery_hashes = $1::jsonb WHERE id = $2", [JSON.stringify(hashes.filter((value) => value !== recoveryHash)), found.id], client);
          return true;
        });
        if (consumed) mfaMethod = "recovery";
      }
      accepted = Boolean(mfaMethod);
    }
    if (!accepted) {
      await securityEvent(db, found ? "operator" : "anonymous", found?.id || null, "login-failed", address);
      send(res, loginPage("Credentials or authentication code were not accepted."), { "cache-control": "no-store" });
      return true;
    }
    const session = await createSession(db, found.id);
    await securityEvent(db, "operator", found.id, "login-succeeded", address, { mfa: found.mfa_enabled, mfaMethod });
    const cookie = `cohort_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secureCookies ? "; Secure" : ""}`;
    redirect(res, "/dashboard", { "set-cookie": cookie, "cache-control": "no-store" });
    return true;
  }
  if (req.method === "POST" && path === "/logout") {
    const body = await webBody(req); assertCsrf(operator, body);
    const token = parseCookies(req.headers.cookie).cohort_session;
    await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    redirect(res, "/", { "set-cookie": "cohort_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
    return true;
  }
  if (req.method === "GET" && path === "/dashboard") {
    if (!operator) redirect(res, "/login");
    else send(res, await dashboardPage(db, operator), { "cache-control": "private, no-store" });
    return true;
  }
  if (req.method === "POST" && path === "/agents") {
    if (!operator) throw Object.assign(new Error("Sign in first"), { status: 401 });
    const body = await webBody(req); assertCsrf(operator, body);
    const result = await createAgent(db, operator.id, required(body.name, "Agent name", 80), required(body.purpose, "Purpose", 1000), required(body.public_key, "Ed25519 public key", 1000));
    send(res, await dashboardPage(db, operator, { notice: `Agent ${result.id} (${result.keyFingerprint}) is pending moderator approval. Sign requests with that ID once it is approved.` }), { "cache-control": "private, no-store" });
    return true;
  }
  if (req.method === "POST" && path === "/account/survey") {
    if (!operator) throw Object.assign(new Error("Sign in first"), { status: 401 });
    const body = await webBody(req); assertCsrf(operator, body);
    const answer = String(body.answer || "");
    if (!["professional", "personal", "undisclosed"].includes(answer)) throw Object.assign(new Error("Invalid survey answer"), { status: 400 });
    // Asked once: a later submission cannot revise the sample.
    await db.query("INSERT INTO operator_survey (operator_id, answer) VALUES ($1, $2) ON CONFLICT (operator_id) DO NOTHING", [operator.id, answer]);
    send(res, await dashboardPage(db, operator, { notice: "Thank you — that is the only question." }), { "cache-control": "private, no-store" });
    return true;
  }
  // The only authenticated surface an operator owing a rotation can reach, so
  // it renders standalone rather than as a panel on the dashboard.
  if (req.method === "GET" && path === "/account/password") {
    if (!operator) redirect(res, "/login");
    else if (operator.password_reset_required) send(res, passwordRotationPage(operator), { "cache-control": "private, no-store" });
    else redirect(res, "/dashboard");
    return true;
  }
  if (req.method === "POST" && path === "/account/password") {
    if (!operator) throw Object.assign(new Error("Sign in first"), { status: 401 });
    const body = await webBody(req); assertCsrf(operator, body);
    const rotating = Boolean(operator.password_reset_required);
    if (!verifyPassword(String(body.current_password || ""), operator.password_hash)) {
      if (rotating) {
        send(res, passwordRotationPage(operator, "The one-time password was not accepted."), { "cache-control": "private, no-store" });
        return true;
      }
      throw Object.assign(new Error("Current password was not accepted"), { status: 403 });
    }
    const password = required(body.new_password, "New password", 200);
    if (password.length < 12) throw Object.assign(new Error("New password must be at least 12 characters"), { status: 400 });
    // Reusing the minted password would leave the account on a credential its
    // owner never chose, which is the thing the rotation exists to end.
    if (rotating && verifyPassword(password, operator.password_hash)) {
      send(res, passwordRotationPage(operator, "Choose a password different from the one you were given."), { "cache-control": "private, no-store" });
      return true;
    }
    await db.transaction(async (client) => {
      await db.query("UPDATE operators SET password_hash = $1, password_reset_required = FALSE WHERE id = $2", [hashPassword(password), operator.id], client);
      await db.query("DELETE FROM sessions WHERE operator_id = $1", [operator.id], client);
    });
    await securityEvent(db, "operator", operator.id, "password-changed", remoteAddress(req), { rotation: rotating });
    redirect(res, "/login");
    return true;
  }
  if (req.method === "POST" && path === "/account/mfa/start") {
    if (!operator) throw Object.assign(new Error("Sign in first"), { status: 401 });
    if (!encryptionKey) throw new Error("APP_ENCRYPTION_KEY is not configured");
    const body = await webBody(req); assertCsrf(operator, body);
    const secret = generateTotpSecret();
    await db.query("UPDATE operators SET mfa_pending_ciphertext = $1 WHERE id = $2", [encryptSecret(secret, encryptionKey), operator.id]);
    send(res, await dashboardPage(db, operator, { mfaSecret: secret }), { "cache-control": "private, no-store" });
    return true;
  }
  if (req.method === "POST" && path === "/account/mfa/confirm") {
    if (!operator) throw Object.assign(new Error("Sign in first"), { status: 401 });
    const body = await webBody(req); assertCsrf(operator, body);
    if (!operator.mfa_pending_ciphertext || !encryptionKey) throw Object.assign(new Error("Start MFA enrollment first"), { status: 409 });
    const secret = decryptSecret(operator.mfa_pending_ciphertext, encryptionKey);
    if (!verifyTotp(secret, body.code)) throw Object.assign(new Error("Authenticator code was not accepted"), { status: 400 });
    const recoveryCodes = Array.from({ length: 8 }, () => randomToken(12));
    await db.query("UPDATE operators SET mfa_secret_ciphertext = mfa_pending_ciphertext, mfa_pending_ciphertext = NULL, mfa_enabled = TRUE, mfa_recovery_hashes = $1::jsonb WHERE id = $2", [JSON.stringify(recoveryCodes.map(hashToken)), operator.id]);
    await securityEvent(db, "operator", operator.id, "mfa-enabled", remoteAddress(req));
    send(res, await dashboardPage(db, { ...operator, mfa_enabled: true, mfa_pending_ciphertext: null }, { notice: "Multi-factor authentication is enabled.", recoveryCodes }), { "cache-control": "private, no-store" });
    return true;
  }
  return false;
}
