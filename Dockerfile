# syntax=docker/dockerfile:1.7
# One image for the API, the worker, migrations and the fake SMTP server;
# docker-compose picks the command. The dashboard has its own image (apps/web/Dockerfile).

FROM node:22-alpine AS build
WORKDIR /app

# Manifests first so dependency installs are cached until a package.json changes.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/fake-smtp/package.json packages/fake-smtp/
COPY packages/server/package.json packages/server/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,target=/root/.npm \
    WS="-w @mailprobe/core -w @mailprobe/fake-smtp -w @mailprobe/server -w @mailprobe/api -w @mailprobe/worker"; \
    if [ -f package-lock.json ]; then npm ci $WS --include-workspace-root; else npm install $WS --include-workspace-root; fi

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN npm run build -w @mailprobe/fake-smtp \
 && npm run build -w @mailprobe/core \
 && npm run build -w @mailprobe/server \
 && npm run build -w @mailprobe/api \
 && npm run build -w @mailprobe/worker \
 && npm prune --omit=dev -w @mailprobe/core -w @mailprobe/fake-smtp -w @mailprobe/server -w @mailprobe/api -w @mailprobe/worker

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# tini reaps zombies and forwards SIGTERM so graceful shutdown actually runs.
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/api/package.json /app/apps/api/openapi.yaml ./apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --chown=node:node db ./db
COPY --chown=node:node deploy ./deploy
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
