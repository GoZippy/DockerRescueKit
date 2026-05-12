# DockerRescueKit — developer Makefile
#
# Conventions:
#   - Bash-compatible syntax. On Windows, run from Git Bash or use mingw32-make.
#   - Targets ending in `## description` are auto-listed by `make help`.
#
# Quick examples:
#   make install        # install all workspace deps
#   make dev-all        # backend + frontend with hot reload (parallel)
#   make docker-up      # start prod container, tail logs
#   make e2e            # headless browser smoke test

SHELL          := /bin/bash
.SHELLFLAGS    := -eu -o pipefail -c

IMAGE          ?= dockerrescuekit/backend:latest
EXT_IMAGE      ?= dockerrescuekit/extension:latest
CONTAINER      ?= drk
HEALTH_URL     ?= http://localhost:42880/healthz
E2E_DIR        ?= /tmp/drk-ui-test

.DEFAULT_GOAL  := help

.PHONY: help install build dev dev-frontend dev-all test test-backend test-watch \
        test-integration \
        lint clean docker-build docker-up docker-down docker-clean docker-logs \
        docker-shell e2e key health release \
        build-extension install-extension uninstall-extension update-extension \
        start stop prod prod-stop logs run

# ── Help ──────────────────────────────────────────────────────────────────────

help: ## Show this help (default target)
	@echo ""
	@echo "DockerRescueKit — available targets:"
	@echo ""
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo ""
	@echo "Tip (Windows): if 'make' isn't on PATH, use 'mingw32-make' or run from Git Bash."
	@echo ""

# ── Workspace lifecycle ───────────────────────────────────────────────────────

install: ## Install all workspace dependencies (npm install at the root)
	npm install

build: ## Build all workspaces (npm run build)
	npm run build

dev: ## Start backend in watch mode (ts-node-dev)
	cd packages/backend && npm run dev

dev-frontend: ## Start the Vite dev server for the extension UI
	cd packages/extension && npm run dev

dev-all: ## Run backend + frontend in parallel (uses make -j2)
	@$(MAKE) -j2 dev dev-frontend

# ── Tests / lint ──────────────────────────────────────────────────────────────

test: ## Run tests across all workspaces
	npm run test --workspaces

test-backend: ## Run backend Jest suite once
	cd packages/backend && npx jest

test-watch: ## Run backend Jest suite in watch mode
	cd packages/backend && npx jest --watch

test-integration: ## Spin up MinIO, run the real-S3 integration test, then tear down
	docker compose -f packages/backend/docker-compose.test.yml up -d
	sleep 5
	cd packages/backend && CI_INTEGRATION=1 npx jest src/__tests__/integration/s3Adapter.real.test.ts
	docker compose -f packages/backend/docker-compose.test.yml down

lint: ## Lint all workspaces (best-effort, --if-present)
	-npm run lint --workspaces --if-present

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean: ## Remove node_modules and dist everywhere
	@echo "Removing node_modules and dist directories..."
	rm -rf node_modules
	rm -rf packages/*/node_modules
	rm -rf packages/*/dist

# ── Docker (production image) ─────────────────────────────────────────────────

docker-build: ## Build the prod Docker image (docker compose build)
	docker compose build

docker-up: ## Start prod container detached and tail its logs
	docker compose up -d
	docker logs -f $(CONTAINER)

docker-down: ## Stop containers (keeps volumes)
	docker compose down

docker-clean: ## Stop containers AND wipe volumes (destructive)
	docker compose down -v

docker-logs: ## Tail logs from the running container
	docker logs -f $(CONTAINER)

docker-shell: ## Open an interactive shell inside the running container
	docker exec -it $(CONTAINER) sh

# ── Smoke / health ────────────────────────────────────────────────────────────

e2e: ## Run the headless puppeteer smoke test (requires running container)
	cd $(E2E_DIR) && node test.js

key: ## Print the API key from the running container
	@docker exec $(CONTAINER) sh -c 'cat /data/secrets.json 2>/dev/null || echo "secrets.json not found"'

health: ## Curl the /healthz endpoint
	@curl -fsS $(HEALTH_URL) && echo "" || echo "health check failed (is the container running?)"

# ── Release ───────────────────────────────────────────────────────────────────

release: ## Tag a new version (prompts for version)
	@read -p "Version (e.g. 0.4.0): " v; \
	  if [ -z "$$v" ]; then echo "no version given, aborting"; exit 1; fi; \
	  echo "Tagging v$$v..."; \
	  git tag -a "v$$v" -m "Release v$$v"; \
	  echo "Created tag v$$v. Push with: git push origin v$$v"

# ── Legacy targets (kept for backwards compatibility) ─────────────────────────

build-extension: ## (legacy) Build the Docker Desktop extension image
	docker build -f packages/backend/Dockerfile -t $(IMAGE) .
	docker tag $(IMAGE) dockerrescuekit/extension-backend:latest
	docker build -t $(EXT_IMAGE) .

install-extension: build-extension ## (legacy) Install the Docker Desktop extension
	docker extension install $(EXT_IMAGE) -f

update-extension: build-extension ## (legacy) Update the installed Docker Desktop extension
	docker extension update $(EXT_IMAGE) -f

uninstall-extension: ## (legacy) Uninstall the Docker Desktop extension
	docker extension uninstall $(EXT_IMAGE)

run: ## (legacy) docker compose up -d
	docker compose up -d

start: ## (legacy) Launch backend + Vite dev server via start script
	@if [ "$(OS)" = "Windows_NT" ]; then \
	    powershell -ExecutionPolicy Bypass -File start.ps1; \
	else \
	    bash start.sh; \
	fi

stop: ## (legacy) Stop all local dev processes via stop script
	@if [ "$(OS)" = "Windows_NT" ]; then \
	    powershell -ExecutionPolicy Bypass -File stop.ps1; \
	else \
	    bash stop.sh; \
	fi

prod: ## (legacy) Build and start prod via docker-compose.prod.yml
	docker compose -f docker-compose.prod.yml up -d --build

prod-stop: ## (legacy) Stop the docker-compose.prod.yml stack
	docker compose -f docker-compose.prod.yml down

logs: ## (legacy) Stream logs from the docker-compose.prod.yml stack
	docker compose -f docker-compose.prod.yml logs -f
