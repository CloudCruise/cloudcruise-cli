# Build from the repo root: docker build -f packages/mcp/Dockerfile .
# The root lockfile and packages/core sit outside this directory.
#
# Runtime config comes from the environment at deploy time; nothing is baked
# in: PORT (default 8080), CLOUDCRUISE_API_BASE_URL, CLOUDCRUISE_OAUTH_ISSUER,
# MCP_PUBLIC_URL.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
# TypeScript and @types/node are root devDependencies, so the build stage
# includes the root; the runtime stage below does not.
RUN npm ci --ignore-scripts --include-workspace-root -w @cloudcruise/strata -w @cloudcruise/mcp
COPY packages/core packages/core
COPY packages/mcp packages/mcp
RUN npm run build -w @cloudcruise/strata && npm run build -w @cloudcruise/mcp

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
# -w limits the install to these two workspaces; the CLI's own deps are skipped.
RUN npm ci --ignore-scripts --omit=dev -w @cloudcruise/strata -w @cloudcruise/mcp \
  && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
USER node
EXPOSE 8080
# Exec form: node is PID 1 and receives Porter's SIGTERM directly.
CMD ["node", "packages/mcp/dist/main.js"]
