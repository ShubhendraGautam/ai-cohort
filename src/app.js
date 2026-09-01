import { createServer } from "node:http";

import { createCohortA2AApp } from "./a2a/cohort-server.js";
import { json, send } from "./http/primitives.js";
import { notFoundPage } from "./pages/public-pages.js";
import { handleAdminRoutes } from "./routes/admin-routes.js";
import { handleAgentCohortRoutes } from "./routes/agent-cohort-routes.js";
import { handleAgentApiRoutes } from "./routes/agent-api-routes.js";
import { handleCohortRoutes } from "./routes/cohort-routes.js";
import { handleControlApiRoutes } from "./routes/control-api-routes.js";
import { handleOperatorRoutes } from "./routes/operator-routes.js";
import { handlePublicRoutes } from "./routes/public-routes.js";
import { currentOperator } from "./security/operator-auth.js";
import { errorPage } from "./views.js";

const routeHandlers = [
  handlePublicRoutes,
  handleOperatorRoutes,
  handleCohortRoutes,
  handleAdminRoutes,
  handleControlApiRoutes,
  handleAgentCohortRoutes,
  handleAgentApiRoutes,
];

export function createApp({
  db,
  coordinator,
  encryptionKey = process.env.APP_ENCRYPTION_KEY,
  secureCookies = process.env.NODE_ENV === "production",
  retentionDays = Number(process.env.DIRECT_MESSAGE_RETENTION_DAYS || 30),
  requireAdminMfa = process.env.NODE_ENV === "production",
  agentTokenSecret = process.env.AGENT_TOKEN_SECRET || encryptionKey,
  publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
}) {
  if (!db) throw new Error("db is required");
  if (!coordinator) throw new Error("coordinator is required");
  if (!agentTokenSecret) throw new Error("agentTokenSecret is required");
  const a2aApp = createCohortA2AApp({ db, coordinator, agentTokenSecret, publicBaseUrl });

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let operator = null;

    if (path === "/.well-known/agent-card.json" || path.startsWith("/a2a")) {
      a2aApp(req, res);
      return;
    }

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
        agentTokenSecret,
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

      if (path.startsWith("/api/") || path.startsWith("/control/") || path.startsWith("/agent/")) {
        json(res, status, { error: status === 500 ? "Internal server error" : error.message }, headers);
        return;
      }

      if (status === 500) console.error(error);
      send(res, errorPage(status === 500 ? "An unexpected error occurred." : error.message, operator, status), headers);
    }
  });
}
