# syntax=docker/dockerfile:1.6
# Docker Desktop Extension image.
# Packages the backend + built UI + extension metadata into a single image
# that `docker extension install` can consume.

FROM dockerrescuekit/extension-backend:latest AS backend

FROM alpine:3.19 AS final
LABEL org.opencontainers.image.title="Docker Rescue Kit" \
      org.opencontainers.image.description="Backup and restore for Docker containers, volumes, and stacks" \
      org.opencontainers.image.vendor="DockerRescueKit" \
      com.docker.desktop.extension.api.version="0.3.4" \
      com.docker.extension.screenshots="[]" \
      com.docker.desktop.extension.icon="drk-icon.svg" \
      com.docker.extension.detailed-description="Scheduled backups, point-in-time restore, SMB/S3 destinations, compose-stack aware." \
      com.docker.extension.publisher-url="https://github.com/" \
      com.docker.extension.categories="backup,utility-tools" \
      com.docker.extension.changelog="See CHANGELOG.md"

COPY metadata.json                       /metadata.json
COPY docker-compose.extension.yml        /docker-compose.extension.yml
COPY drk-icon.svg                        /drk-icon.svg
COPY --from=backend /app/public          /ui

CMD ["sh", "-c", "echo DockerRescueKit extension image — consumed by docker extension install"]
