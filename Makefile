# This repository does not publish images. Build them locally; the default
# namespace is a plain local name, not a registry path. Override IMAGE when you
# want to load it into a private registry your own cluster can pull from.
IMAGE ?= deepseek-harness
DSH_VERSION ?= 0.2.1-rc.5
IMAGE_VERSION ?= $(DSH_VERSION)-r1
NODE_IMAGE ?= docker.io/library/node:24-trixie
PNPM_VERSION ?= 10.15.1
DSH_MARKET_VERSION ?= 1.66.9
MARKET_IMAGE_VERSION ?= $(IMAGE_VERSION)-market.1
BROWSER_PLUGIN_VERSION ?= 0.1.5
BWRAP_IMAGE_VERSION ?= $(IMAGE_VERSION)-bwrap.1
UNGOOGLED_CHROMIUM_VERSION ?= 152.0.7977.82-1
UNGOOGLED_CHROMIUM_AMD64_SHA256 ?= 2c6e464e030f87145e42553c5aa539f6e62163ce677d3eace3c51b4fcbd5e347
UNGOOGLED_CHROMIUM_ARM64_SHA256 ?= 1909f42dcc3661bc213f2cf3b5232a9d3c850913b36efa7267ed6499f6cbf87d
UNGOOGLED_IMAGE_VERSION ?= $(IMAGE_VERSION)-ungoogled.1
PODMAN ?= podman
PODMAN_COMPOSE ?= podman-compose
PLATFORMS ?= linux/amd64,linux/arm64

.PHONY: help build multiarch-build push pull ghcr-pull bwrap-build bwrap-push bwrap-pull bwrap-smoke bwrap-inspect ungoogled-build ungoogled-multiarch-build ungoogled-push ungoogled-pull ungoogled-smoke ungoogled-inspect market-build market-push market-pull up down logs podman-up podman-down podman-logs podman-smoke compose-check helm-check plugin-check dockerhub-check version-check verify upstream-check smoke market-smoke inspect ghcr-inspect market-inspect

help:
	@echo "build            Build the local platform image"
	@echo "multiarch-build  Build both release platforms without pushing"
	@echo "push             Retired: this repository does not publish images"
	@echo "pull             Retired: images are built locally"
	@echo "ghcr-pull        Retired: there is no GHCR mirror"
	@echo "bwrap-build      Build the opt-in bubblewrap sandbox variant"
	@echo "bwrap-push       Retired: build local variant images only"
	@echo "bwrap-smoke      Verify workspace writes and denial outside it"
	@echo "ungoogled-build  Build the privacy-focused Chromium variant"
	@echo "ungoogled-push   Retired: build local variant images only"
	@echo "ungoogled-smoke  Test Harness/noVNC and reject GCM port 5228 activity"
	@echo "market-build     Build the optional community-market image"
	@echo "market-push      Retired: build local variant images only"
	@echo "up/down/logs     Manage the Compose service"
	@echo "podman-up/down   Manage the rootless Podman Compose deployment"
	@echo "podman-smoke     Test bind ownership, Web health, and loopback ports under rootless Podman"
	@echo "verify           Validate Compose and Helm rendering"
	@echo "plugin-check     Validate and dry-pack the browser plugin"
	@echo "dockerhub-check  Render README locally (no Docker Hub sync; publishing disabled)"
	@echo "version-check    Verify pinned versions across build and deployment files"
	@echo "upstream-check   Compare the pinned DSH version with GitHub and npm"
	@echo "smoke            Exercise CLI, config, PTY, and Web startup"
	@echo "inspect          Retired: there is no remotely published manifest"

build:
	docker build --pull --build-arg DSH_VERSION=$(DSH_VERSION) --build-arg IMAGE_VERSION=$(IMAGE_VERSION) --build-arg IMAGE_REVISION=$$(git describe --always --dirty) --build-arg NODE_IMAGE=$(NODE_IMAGE) --build-arg PNPM_VERSION=$(PNPM_VERSION) --tag $(IMAGE):$(IMAGE_VERSION) .

multiarch-build:
	docker buildx build --platform $(PLATFORMS) --build-arg DSH_VERSION=$(DSH_VERSION) --build-arg IMAGE_VERSION=$(IMAGE_VERSION) --build-arg IMAGE_REVISION=$$(git describe --always --dirty) --build-arg NODE_IMAGE=$(NODE_IMAGE) --build-arg PNPM_VERSION=$(PNPM_VERSION) --tag $(IMAGE):$(IMAGE_VERSION) .

push:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

pull:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

ghcr-pull:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

bwrap-build:
	docker build --pull --file Dockerfile.bwrap --build-arg BASE_IMAGE=$(IMAGE):$(IMAGE_VERSION) --build-arg BWRAP_IMAGE_VERSION=$(BWRAP_IMAGE_VERSION) --tag $(IMAGE):$(BWRAP_IMAGE_VERSION) .

bwrap-push:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

bwrap-pull:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

ungoogled-build:
	docker build --pull --build-arg DSH_VERSION=$(DSH_VERSION) --build-arg IMAGE_VERSION=$(UNGOOGLED_IMAGE_VERSION) --build-arg IMAGE_REVISION=$$(git describe --always --dirty) --build-arg NODE_IMAGE=$(NODE_IMAGE) --build-arg PNPM_VERSION=$(PNPM_VERSION) --build-arg CHROMIUM_FLAVOR=ungoogled --build-arg UNGOOGLED_CHROMIUM_VERSION=$(UNGOOGLED_CHROMIUM_VERSION) --build-arg UNGOOGLED_CHROMIUM_AMD64_SHA256=$(UNGOOGLED_CHROMIUM_AMD64_SHA256) --build-arg UNGOOGLED_CHROMIUM_ARM64_SHA256=$(UNGOOGLED_CHROMIUM_ARM64_SHA256) --tag $(IMAGE):$(UNGOOGLED_IMAGE_VERSION) .

ungoogled-multiarch-build:
	docker buildx build --platform $(PLATFORMS) --build-arg DSH_VERSION=$(DSH_VERSION) --build-arg IMAGE_VERSION=$(UNGOOGLED_IMAGE_VERSION) --build-arg IMAGE_REVISION=$$(git describe --always --dirty) --build-arg NODE_IMAGE=$(NODE_IMAGE) --build-arg PNPM_VERSION=$(PNPM_VERSION) --build-arg CHROMIUM_FLAVOR=ungoogled --build-arg UNGOOGLED_CHROMIUM_VERSION=$(UNGOOGLED_CHROMIUM_VERSION) --build-arg UNGOOGLED_CHROMIUM_AMD64_SHA256=$(UNGOOGLED_CHROMIUM_AMD64_SHA256) --build-arg UNGOOGLED_CHROMIUM_ARM64_SHA256=$(UNGOOGLED_CHROMIUM_ARM64_SHA256) --tag $(IMAGE):$(UNGOOGLED_IMAGE_VERSION) .

ungoogled-push:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

ungoogled-pull:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

market-build:
	docker build --pull --file Dockerfile.market --build-arg BASE_IMAGE=$(IMAGE):$(IMAGE_VERSION) --build-arg NODE_IMAGE=$(NODE_IMAGE) --build-arg DSH_MARKET_VERSION=$(DSH_MARKET_VERSION) --build-arg MARKET_IMAGE_VERSION=$(MARKET_IMAGE_VERSION) --tag $(IMAGE):$(MARKET_IMAGE_VERSION) .

market-push:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

market-pull:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

up:
	docker compose up --detach --no-build

down:
	docker compose down

logs:
	docker compose logs --follow deepseek-harness

compose-check:
	docker compose config --quiet
	docker compose -f compose.yaml -f compose.market.yaml config --quiet
	docker compose -f compose.yaml -f compose.bwrap.yaml config --quiet
	docker compose -f compose.yaml -f compose.podman.yaml config --quiet

helm-check:
	helm lint --strict charts/deepseek-harness
	helm template deepseek-harness charts/deepseek-harness >/dev/null
	helm template deepseek-harness charts/deepseek-harness --set persistence.enabled=false --set credentials.existingSecret=dsh-provider-credentials --set workspace.existingClaim=dsh-workspace >/dev/null

plugin-check:
	node --check scripts/dsh-web-supervisor.cjs
	node --check scripts/dsh-web-proxy.cjs
	node --check scripts/admin-version-policy.cjs
	node --check scripts/admin-failure-decision.cjs
	node --test scripts/dsh-web-supervisor.test.cjs scripts/dsh-web-proxy.test.cjs scripts/admin-version-policy.test.cjs scripts/admin-failure-decision.test.cjs
	node --check plugins/dsh-browser-desktop/index.js
	node --check plugins/dsh-browser-desktop/client.js
	node --check scripts/dsh-market-repair-store
	sh -n scripts/deepseek-harness-entrypoint
	sh -n scripts/dsh-container
	sh -n scripts/deepseek-harness-market-entrypoint
	bash -n scripts/check-upstream-dsh.sh
	bash -n scripts/check-version-consistency.sh
	bash -n scripts/bwrap-smoke.sh
	bash -n scripts/podman-smoke.sh
	bash -n scripts/smoke.sh
	npm --cache "$${TMPDIR:-/tmp}/dsh-browser-plugin-npm-cache" pack --dry-run --json ./plugins/dsh-browser-desktop >/dev/null

dockerhub-check:
	bash -n scripts/render-dockerhub-readme.sh
	bash scripts/render-dockerhub-readme.sh README.md /dev/null

version-check:
	./scripts/check-version-consistency.sh $(DSH_VERSION) $(IMAGE_VERSION) $(PNPM_VERSION) $(DSH_MARKET_VERSION) $(MARKET_IMAGE_VERSION) $(BROWSER_PLUGIN_VERSION) $(UNGOOGLED_CHROMIUM_VERSION) $(UNGOOGLED_IMAGE_VERSION) $(UNGOOGLED_CHROMIUM_AMD64_SHA256) $(UNGOOGLED_CHROMIUM_ARM64_SHA256) $(BWRAP_IMAGE_VERSION) $(IMAGE)

verify: compose-check helm-check plugin-check dockerhub-check version-check

upstream-check:
	./scripts/check-upstream-dsh.sh $(DSH_VERSION)

smoke:
	./scripts/smoke.sh $(IMAGE):$(IMAGE_VERSION) $(DSH_VERSION) $(PNPM_VERSION)

podman-up:
	$(PODMAN_COMPOSE) -f compose.yaml -f compose.podman.yaml pull
	$(PODMAN_COMPOSE) -f compose.yaml -f compose.podman.yaml up --detach --no-build

podman-down:
	$(PODMAN_COMPOSE) -f compose.yaml -f compose.podman.yaml down

podman-logs:
	$(PODMAN_COMPOSE) -f compose.yaml -f compose.podman.yaml logs --follow deepseek-harness

podman-smoke:
	./scripts/podman-smoke.sh $(IMAGE):$(IMAGE_VERSION) $(DSH_VERSION)

bwrap-smoke:
	./scripts/bwrap-smoke.sh $(IMAGE):$(BWRAP_IMAGE_VERSION)

ungoogled-smoke:
	./scripts/smoke.sh $(IMAGE):$(UNGOOGLED_IMAGE_VERSION) $(DSH_VERSION) $(PNPM_VERSION) "" ungoogled $(UNGOOGLED_CHROMIUM_VERSION)

market-smoke:
	./scripts/smoke.sh $(IMAGE):$(MARKET_IMAGE_VERSION) $(DSH_VERSION) $(PNPM_VERSION) $(DSH_MARKET_VERSION)

inspect:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

ghcr-inspect:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

market-inspect:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

ungoogled-inspect:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1

bwrap-inspect:
	@echo "$@ is retired: this repository does not publish images." >&2
	@echo "Build locally instead (make build / make market-build / make bwrap-build / make ungoogled-build) and load it into your own registry or cluster." >&2
	@exit 1
