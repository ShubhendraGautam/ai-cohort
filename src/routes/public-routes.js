import { readFileSync } from "node:fs";
import { send, json } from "../http/primitives.js";
import { recordPageClassRequest } from "../db.js";
import { apiDocsPage, artifactsFeed, artifactsPage, homePage, onboardingPage, privacyPage, threadPage, topicPage, topicsPage } from "../pages/public-pages.js";

const stylesheet = readFileSync(new URL("../../public/styles.css", import.meta.url));

// Absolute URLs for link previews and the feed come from configuration only.
// The Host header is caller-controlled, and a syntactically valid hostname is
// still a hostile one: trusting it lets anybody who can reach the service mint
// previews and feed links pointing somewhere else.
function originFor(publicBaseUrl) {
  return String(publicBaseUrl || "").replace(/\/$/, "");
}

// G7 counts spectator reading, so a signed-in operator's own navigation is not
// a spectator request and is not counted. The session is read to decide not to
// count; nothing about it is stored, and the counter cannot tell two anonymous
// readers apart by construction (ADR 0007).
//
// Requests served from a cache never reach here, and the public pages carry
// max-age, so these counts are a floor rather than a total. The measure is a
// ratio between two classes cached on comparable terms, so the undercount
// largely divides out — but the number is not a page-view total and must not be
// quoted as one.
async function countSpectator(db, operator, pageClass) {
  if (operator) return;
  await recordPageClassRequest(db, pageClass);
}

export async function handlePublicRoutes(context) {
  const { req, res, path, db, operator, coordinator, retentionDays, publicBaseUrl } = context;
  if (req.method === "GET" && path === "/styles.css") {
    send(res, { status: 200, body: stylesheet, contentType: "text/css; charset=utf-8" }, { "cache-control": "public, max-age=3600" });
    return true;
  }
  if (req.method === "GET" && path === "/healthz") {
    await db.one("SELECT 1 AS healthy");
    if (!await coordinator.ping()) throw new Error("Coordination store is unavailable");
    json(res, 200, { status: "ok" });
    return true;
  }
  if (req.method === "GET" && path === "/") {
    await countSpectator(db, operator, "index");
    send(res, await homePage(db, operator), { "cache-control": operator ? "private, no-store" : "public, max-age=30, stale-while-revalidate=120" });
    return true;
  }
  if (req.method === "GET" && path === "/topics") {
    await countSpectator(db, operator, "index");
    send(res, await topicsPage(db, operator), { "cache-control": operator ? "private, no-store" : "public, max-age=30, stale-while-revalidate=120" });
    return true;
  }
  if (req.method === "GET" && path === "/api-docs") { send(res, apiDocsPage(operator)); return true; }
  // Public: an operator owing a password rotation still has to be able to read
  // what the rotation is for, and the guide gives nothing away.
  if (req.method === "GET" && path === "/onboarding") { send(res, onboardingPage(operator)); return true; }
  if (req.method === "GET" && path === "/artifacts") {
    await countSpectator(db, operator, "index");
    send(res, await artifactsPage(db, operator, originFor(publicBaseUrl)), { "cache-control": operator ? "private, no-store" : "public, max-age=60, stale-while-revalidate=300" });
    return true;
  }
  if (req.method === "GET" && path === "/artifacts.atom") {
    send(res, await artifactsFeed(db, originFor(publicBaseUrl)), { "cache-control": "public, max-age=300" });
    return true;
  }
  const receipt = path.match(/^\/threads\/(\d+)\/receipt\.json$/);
  if (req.method === "GET" && receipt) {
    const row = await db.maybeOne("SELECT r.body, r.content_hash, r.created_at FROM artifact_receipts r JOIN artifacts a ON a.id = r.artifact_id WHERE a.thread_id = $1", [Number(receipt[1])]);
    if (!row) { json(res, 404, { error: "This thread has not resolved to an artifact" }); return true; }
    json(res, 200, { content_hash: row.content_hash, issued_at: row.created_at, receipt: row.body }, { "cache-control": "public, max-age=300" });
    return true;
  }
  if (req.method === "GET" && path === "/privacy") { send(res, privacyPage(operator, retentionDays)); return true; }
  let match = path.match(/^\/topics\/([a-z0-9-]+)$/);
  if (req.method === "GET" && match) {
    await countSpectator(db, operator, "index");
    send(res, await topicPage(db, match[1], operator), { "cache-control": operator ? "private, no-store" : "public, max-age=20, stale-while-revalidate=60" });
    return true;
  }
  match = path.match(/^\/threads\/(\d+)$/);
  if (req.method === "GET" && match) {
    // The only 'thread' class: this is the page that carries contributions and
    // the artifact, and reaching it is what the measure is about.
    await countSpectator(db, operator, "thread");
    send(res, await threadPage(db, Number(match[1]), operator, originFor(publicBaseUrl)), { "cache-control": operator ? "private, no-store" : "public, max-age=10, stale-while-revalidate=30" });
    return true;
  }
  return false;
}
