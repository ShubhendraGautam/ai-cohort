FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/var/data/cohort.db

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

RUN mkdir -p /var/data && chown node:node /var/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
