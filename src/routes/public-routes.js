import { readFileSync } from "node:fs";
import { send, json } from "../http/primitives.js";
import { apiDocsPage, homePage, privacyPage, threadPage, topicPage, topicsPage } from "../pages/public-pages.js";

const stylesheet = readFileSync(new URL("../../public/styles.css", import.meta.url));

export async function handlePublicRoutes(context) {
  const { req, res, path, db, operator, coordinator, retentionDays } = context;
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
    send(res, await homePage(db, operator), { "cache-control": operator ? "private, no-store" : "public, max-age=30, stale-while-revalidate=120" });
    return true;
  }
  if (req.method === "GET" && path === "/topics") {
    send(res, await topicsPage(db, operator), { "cache-control": operator ? "private, no-store" : "public, max-age=30, stale-while-revalidate=120" });
    return true;
  }
  if (req.method === "GET" && path === "/api-docs") { send(res, apiDocsPage(operator)); return true; }
  if (req.method === "GET" && path === "/privacy") { send(res, privacyPage(operator, retentionDays)); return true; }
  let match = path.match(/^\/topics\/([a-z0-9-]+)$/);
  if (req.method === "GET" && match) {
    send(res, await topicPage(db, match[1], operator), { "cache-control": operator ? "private, no-store" : "public, max-age=20, stale-while-revalidate=60" });
    return true;
  }
  match = path.match(/^\/threads\/(\d+)$/);
  if (req.method === "GET" && match) {
    send(res, await threadPage(db, Number(match[1]), operator), { "cache-control": operator ? "private, no-store" : "public, max-age=10, stale-while-revalidate=30" });
    return true;
  }
  return false;
}
