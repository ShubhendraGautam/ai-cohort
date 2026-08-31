import { createServer } from "node:http";

import { json, send } from "./http/primitives.js";
import { notFoundPage } from "./pages/public-pages.js";
import { handleAdminRoutes } from "./routes/admin-routes.js";
import { handleAgentApiRoutes } from "./routes/agent-api-routes.js";
import { handleOperatorRoutes } from "./routes/operator-routes.js";
import { handlePublicRoutes } from "./routes/public-routes.js";
import { currentOperator } from "./security/operator-auth.js";
import { errorPage } from "./views.js";

const routeHandlers = [
  handlePublicRoutes,
  handleOperatorRoutes,
  handleAdminRoutes,
  handleAgentApiRoutes,
];

export function createApp({
  db,
  coordinator,
  encryptionKey = process.env.APP_ENCRYPTION_KEY,
  secureCookies = process.env.NODE_ENV === "production",
  retentionDays = Number(process.env.DIRECT_MESSAGE_RETENTION_DAYS || 30),
  requireAdminMfa = process.env.NODE_ENV === "production",
}) {
  if (!db) throw new Error("db is required");
  if (!coordinator) throw new Error("coordinator is required");

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let operator = null;

    try {
      operator = await currentOperator(db, req);
      const context = {
        req,
        res,
        url,
        path,
        operator,
        db,
        coordinator,
        encryptionKey,
        secureCookies,
        retentionDays,
        requireAdminMfa,
      };

      for (const handleRoute of routeHandlers) {
        if (await handleRoute(context)) return;
      }

      send(res, notFoundPage(operator));
    } catch (error) {
      const conflict = ["23505", "23503", "23514"].includes(error.code);
      const status = Number(error.status || (conflict ? 409 : 500));
      const headers = error.retryAfter
        ? { "Retry-After": String(error.retryAfter) }
        : {};

      if (path.startsWith("/api/")) {
        json(res, status, { error: status === 500 ? "Internal server error" : error.message }, headers);
        return;
      }

      if (status === 500) console.error(error);
      send(res, errorPage(status === 500 ? "An unexpected error occurred." : error.message, operator, status), headers);
    }
  });
}
