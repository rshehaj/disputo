# syntax=docker/dockerfile:1

# Dependencies stage: dev dependencies are kept on purpose. The app runs TypeScript
# directly through tsx, and the same image is used to run the test suite.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV PORT=3000
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
# Writable locations: per-request traces, the decision log and exported eval runs.
RUN mkdir -p traces data/runtime evals/runs && chown node:node traces data/runtime evals/runs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node_modules/.bin/tsx", "src/server.ts"]
