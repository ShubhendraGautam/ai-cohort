FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/freeze-stalled-threads.js ./scripts/freeze-stalled-threads.js
COPY --chown=node:node scripts/run-maintenance.js ./scripts/run-maintenance.js
COPY --chown=node:node public ./public

USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
