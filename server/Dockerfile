# Server image (HARD-A1) — ONE image, three roles.
# The same built code runs as the API, the worker fleet, or the single-leader
# scheduler; PROCESS_ROLE (set per docker-compose service) selects which
# components start. Scale `worker` horizontally; run exactly ONE `scheduler`.
FROM node:20-alpine AS build
WORKDIR /app

# Install workspace deps (root + server). The repo is an npm workspace, so the
# root package.json + lockfile drive install; the server package is a workspace.
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json ./server/
RUN npm ci --workspace server --include-workspace-root

COPY server ./server
RUN npm run build --workspace server \
  && npm run db:generate --workspace server

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/
# The shared classifier spec (MED-A2) is read at runtime from <repo>/shared.
COPY shared ./shared

WORKDIR /app/server
# Default role is "all"; docker-compose overrides PROCESS_ROLE per service.
CMD ["node", "dist/index.js"]
