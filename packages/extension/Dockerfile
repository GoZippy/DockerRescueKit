# syntax=docker/dockerfile:1.6
# Standalone UI image. For the single-container distribution we prefer
# letting the backend serve static files — this image is for the Docker
# Desktop Extension's "ui" container which runs alongside the backend.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json    packages/shared/package.json
COPY packages/extension/package.json packages/extension/package.json
RUN npm ci --workspaces --include-workspace-root
COPY packages/shared    packages/shared
COPY packages/extension packages/extension
RUN npm run build --workspace=@docker-rescue-kit/shared \
 && npm run build --workspace=@docker-rescue-kit/extension

FROM scratch AS ui
COPY --from=build /app/packages/extension/dist /ui
