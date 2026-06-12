# drk-mcp — thin stdio MCP server image for the Docker MCP Catalog.
#
# Build from the REPO ROOT so the @docker-rescue-kit/shared workspace
# (referenced as file:../shared) is in context:
#
#   docker build -f packages/mcp/Dockerfile -t gozippy/drk-mcp:latest .
#
# Run (agent launches it over stdio; it talks to the DRK backend + the daemon):
#
#   docker run -i --rm \
#     -e DRK_URL=http://host.docker.internal:42880 \
#     -e DRK_API_KEY=$DRK_API_KEY \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     gozippy/drk-mcp:latest

# ---- build stage -----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Shared package first (mcp depends on it via file:../shared).
COPY packages/shared/package.json ./packages/shared/
COPY packages/mcp/package.json packages/mcp/package-lock.json ./packages/mcp/

# Bring in shared sources so the file: dependency resolves, then install.
COPY packages/shared ./packages/shared
RUN cd packages/shared && npm install --no-audit --no-fund && npm run build

WORKDIR /app/packages/mcp
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY packages/mcp/tsconfig.json ./
COPY packages/mcp/src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:20-alpine AS runtime
LABEL org.opencontainers.image.title="drk-mcp" \
      org.opencontainers.image.description="Docker Rescue Kit Prune Guard MCP server — snapshot-before-prune safety tools for AI agents." \
      org.opencontainers.image.source="https://github.com/gozippy/docker-rescue-kit"
ENV NODE_ENV=production \
    DRK_URL=http://localhost:42880

# The compose CLI is OPTIONAL — only safe_compose_down needs it. The Docker CLI
# is small; include it so safe_compose_down works out of the box. Remove these
# two lines to ship a leaner image if you only use safe_prune / snapshot_volumes.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app/packages/mcp
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/packages/mcp/node_modules ./node_modules
COPY --from=build /app/packages/mcp/dist ./dist
COPY --from=build /app/packages/mcp/package.json ./

# stdio transport: the agent speaks JSON-RPC over stdin/stdout.
ENTRYPOINT ["node", "dist/index.js"]
