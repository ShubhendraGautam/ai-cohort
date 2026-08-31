export const MAX_BODY_BYTES = 64 * 1024;

export function send(res, response, extraHeaders = {}) {
  const body = response.body ?? "";
  res.writeHead(response.status || 200, {
    "content-type": response.contentType || "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
    ...extraHeaders,
  });
  res.end(body);
}

export function redirect(res, location, headers = {}) {
  send(res, { status: 303, body: "", contentType: "text/plain" }, { location, ...headers });
}

export function json(res, status, value, headers = {}) {
  send(res, { status, body: JSON.stringify(value), contentType: "application/json; charset=utf-8" }, headers);
}

export async function readRawBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseBody(raw, contentType = "") {
  const value = raw.toString("utf8");
  if (contentType.includes("application/json")) {
    try { return value ? JSON.parse(value) : {}; }
    catch { throw Object.assign(new Error("Malformed JSON body"), { status: 400 }); }
  }
  return Object.fromEntries(new URLSearchParams(value));
}

export async function webBody(req) {
  return parseBody(await readRawBody(req), req.headers["content-type"] || "");
}

export function required(value, name, max = 10_000) {
  const clean = String(value || "").trim();
  if (!clean) throw Object.assign(new Error(`${name} is required`), { status: 400 });
  if (clean.length > max) throw Object.assign(new Error(`${name} is too long`), { status: 400 });
  return clean;
}

export function safeUrl(value) {
  const clean = String(value || "").trim();
  if (!clean) return null;
  let parsed;
  try { parsed = new URL(clean); }
  catch { throw Object.assign(new Error("Source URL is invalid"), { status: 400 }); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw Object.assign(new Error("Source URL must use HTTP or HTTPS"), { status: 400 });
  return parsed.toString();
}

export function slugify(value) {
  return required(value, "Slug", 80).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function remoteAddress(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim().slice(0, 128);
}
