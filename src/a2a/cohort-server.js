import { randomUUID } from "node:crypto";
import express from "express";
import { Role } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";

import { PRIVATE_COHORT_EXTENSION, storeCohortMessage } from "../cohorts/service.js";
import { remoteAddress } from "../http/primitives.js";
import { authenticatedTokenAgent } from "../security/agent-tokens.js";
import { PostgresTaskStore } from "./postgres-task-store.js";

function agentCard(publicBaseUrl) {
  return {
    name: "AI Cohort private assistant router",
    description: "Routes consent-bound messages between independently owned personal assistants.",
    supportedInterfaces: [{
      url: `${publicBaseUrl.replace(/\/$/, "")}/a2a`,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: "1.0",
    }],
    provider: {
      organization: "AI Cohort",
      url: publicBaseUrl,
    },
    version: "0.2.0",
    documentationUrl: `${publicBaseUrl.replace(/\/$/, "")}/api-docs`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [{
        uri: PRIVATE_COHORT_EXTENSION,
        description: "Carries private cohort routing, consent, and authority metadata.",
        required: true,
        params: {
          authority: ["chat_only", "proposal_only"],
          contextGrants: false,
        },
      }],
    },
    securitySchemes: {
      agentBearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "Five-minute JWT obtained with an approved assistant's Ed25519 identity.",
            scheme: "Bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { agentBearer: { list: [] } } }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{
      id: "private-assistant-message",
      name: "Private assistant message",
      description: "Deliver a consent-bound message to another assistant in an active private cohort.",
      tags: ["private", "coordination", "consent"],
      examples: ["Ask the other assistant which proposed meeting window best matches its owner's constraints."],
      inputModes: ["text/plain", "application/json"],
      outputModes: ["application/json"],
      securityRequirements: [{ schemes: { agentBearer: { list: [] } } }],
    }],
    signatures: [],
  };
}

class CohortRouterExecutor {
  constructor(db) {
    this.db = db;
  }

  async execute(requestContext, eventBus) {
    const userMessage = requestContext.userMessage;
    if (userMessage.role !== Role.ROLE_USER) {
      throw Object.assign(new Error("Client messages must use ROLE_USER"), { status: 400 });
    }
    if (!requestContext.context.requestedExtensions?.includes(PRIVATE_COHORT_EXTENSION)) {
      throw Object.assign(new Error("The private cohort A2A extension must be requested"), { status: 400 });
    }
    requestContext.context.addActivatedExtension(PRIVATE_COHORT_EXTENSION);
    const senderAgentId = Number(requestContext.context.user.userName);
    const stored = await storeCohortMessage(this.db, senderAgentId, {
      ...userMessage,
      contextId: userMessage.contextId || requestContext.contextId,
    });
    eventBus.publish(AgentEvent.message({
      messageId: randomUUID(),
      contextId: stored.context_id,
      taskId: stored.task_id || "",
      role: Role.ROLE_AGENT,
      parts: [{
        content: {
          $case: "data",
          value: {
            accepted: true,
            messageId: stored.id,
            cohortId: stored.cohort_id,
            recipientAssistantId: Number(stored.recipient_agent_id),
          },
        },
        metadata: undefined,
        filename: "",
        mediaType: "application/json",
      }],
      metadata: {
        [PRIVATE_COHORT_EXTENSION]: {
          cohortId: stored.cohort_id,
          recipientAssistantId: Number(stored.recipient_agent_id),
        },
      },
      extensions: [PRIVATE_COHORT_EXTENSION],
      referenceTaskIds: [],
    }));
    eventBus.finished();
  }

  async cancelTask() {
    throw Object.assign(new Error("Message delivery cannot be canceled after acceptance"), { status: 409 });
  }
}

export function createCohortA2AApp({ db, coordinator, agentTokenSecret, publicBaseUrl }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    next();
  });
  const requestHandler = new DefaultRequestHandler(
    agentCard(publicBaseUrl),
    new PostgresTaskStore(db),
    new CohortRouterExecutor(db),
  );

  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 300 } }),
  );
  app.use("/a2a", async (req, res, next) => {
    try {
      const address = remoteAddress(req);
      const ipRate = await coordinator.rateLimit(`a2a-ip:${address}`, 300, 60);
      if (!ipRate.allowed) {
        res.setHeader("retry-after", String(ipRate.retryAfter));
        res.status(429).json({ error: "A2A source rate limit exceeded" });
        return;
      }
      const authenticated = await authenticatedTokenAgent(db, req, agentTokenSecret);
      const agentRate = await coordinator.rateLimit(`a2a-agent:${authenticated.agent.id}`, 60, 60);
      if (!agentRate.allowed) {
        res.setHeader("retry-after", String(agentRate.retryAfter));
        res.status(429).json({ error: "A2A assistant rate limit exceeded" });
        return;
      }
      req.cohortAgent = authenticated.agent;
      next();
    } catch (error) {
      res.status(error.status || 401).json({ error: error.message });
    }
  });
  app.use("/a2a", jsonRpcHandler({
    requestHandler,
    userBuilder: async (req) => ({
      get isAuthenticated() { return true; },
      get userName() { return String(req.cohortAgent.id); },
    }),
  }));
  app.use((error, _req, res, _next) => {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "A2A server error" });
  });
  return app;
}
