#!/usr/bin/env bash
set -Eeuo pipefail

dsh_version="${1:?missing DSH version}"
image_version="${2:?missing image version}"
pnpm_version="${3:?missing pnpm version}"
market_version="${4:?missing market version}"
market_image_version="${5:?missing market image version}"
browser_plugin_version="${6:?missing browser plugin version}"
ungoogled_chromium_version="${7:?missing ungoogled-chromium version}"
ungoogled_image_version="${8:?missing ungoogled image version}"
ungoogled_amd64_sha256="${9:?missing ungoogled-chromium amd64 sha256}"
ungoogled_arm64_sha256="${10:?missing ungoogled-chromium arm64 sha256}"
bwrap_image_version="${11:?missing bubblewrap image version}"
image_repository="${12:?missing image repository}"

require_literal() {
  local file="$1"
  local literal="$2"
  if ! grep -F --quiet -- "${literal}" "${file}"; then
    printf 'version consistency check failed: %s does not contain %s\n' "${file}" "${literal}" >&2
    return 1
  fi
}

# A partial bump is the failure mode this guard exists for: one file moves to a
# new release while the rest of the build stays behind, and every single-pin
# assertion above still passes because each file is individually coherent.
# These files carry no release history, so any DSH release literal other than
# the pinned one is stale by definition.
#
# Two inputs are excluded, both for the same reason: they are prose about past
# releases rather than build pins.
#   - Chart.yaml's artifacthub.io/changes block accumulates one entry per
#     release, so it names the previous version forever.
#   - README/SKILL command snippets are asserted explicitly at the bottom of
#     this script instead, because the surrounding prose must keep its
#     historical screenshot captions on older versions.
require_no_stale_release() {
  local file literal
  for file in "$@"; do
    if [[ ! -f "${file}" ]]; then
      printf 'version consistency check failed: %s is missing\n' "${file}" >&2
      return 1
    fi
    local stale
    # Only a no-match grep (exit 1) is acceptable. Anything else -- an unreadable
    # file, a broken argument -- must fail loudly instead of silently narrowing
    # the coverage this guard exists to provide.
    stale="$(grep -Eo '[0-9]+\.[0-9]+\.[0-9]+-(alpha|beta|rc)\.[0-9]+' "${file}")" || {
      local status=$?
      if [[ "${status}" -eq 1 ]]; then
        stale=""
      else
        printf 'version consistency check failed: could not scan %s\n' "${file}" >&2
        return 1
      fi
    }
    local filtered
    filtered="$(grep -F -v -x -- "${dsh_version}" <<<"${stale}")" || true
    if [[ -n "${filtered}" ]]; then
      printf 'version consistency check failed: %s still refers to %s (pinned DSH is %s)\n' \
        "${file}" "$(tr '\n' ' ' <<<"${filtered}" | sed 's/ $//')" "${dsh_version}" >&2
      return 1
    fi
  done
}

# Chart.yaml is checked through its two structural pins only (appVersion and
# artifacthub.io/images); see the note above for why its changes block cannot
# be scanned for stale literals.
require_no_stale_release \
  Dockerfile \
  Dockerfile.market \
  Dockerfile.bwrap \
  compose.yaml \
  compose.market.yaml \
  compose.bwrap.yaml \
  compose.podman.yaml \
  .env.example \
  Makefile \
  charts/deepseek-harness/values.yaml \
  scripts/smoke.sh \
  scripts/podman-smoke.sh \
  scripts/bwrap-smoke.sh \
  scripts/check-upstream-dsh.sh \
  .github/workflows/ci.yml \
  .github/workflows/publish-dockerhub.yml \
  .github/workflows/publish-ghcr.yml \
  .github/workflows/upstream-dsh.yml

require_literal Dockerfile "ARG DSH_VERSION=${dsh_version}"
require_literal Dockerfile "ARG IMAGE_VERSION=${image_version}"
require_literal Dockerfile "ARG PNPM_VERSION=${pnpm_version}"
require_literal Dockerfile '"@deepseek-ai/dsh-browser-use@${DSH_VERSION}"'
require_literal Dockerfile '"@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@${DSH_VERSION}"'
require_literal Dockerfile 'COPY scripts/dsh-container /usr/local/bin/dsh'
require_literal Dockerfile 'COPY scripts/dsh-web-supervisor.cjs /opt/deepseek-harness/dsh-web-supervisor.cjs'
require_literal Dockerfile 'COPY scripts/dsh-web-proxy.cjs /opt/deepseek-harness/dsh-web-proxy.cjs'
require_literal web.cordis.patch.yml "host: '127.0.0.1'"
require_literal web.market.cordis.patch.yml "host: '127.0.0.1'"
require_literal Dockerfile "ARG NODE_IMAGE=docker.io/library/node:24-trixie"
require_literal Dockerfile "ARG UNGOOGLED_CHROMIUM_VERSION=${ungoogled_chromium_version}"
require_literal Dockerfile "ARG UNGOOGLED_CHROMIUM_AMD64_SHA256=${ungoogled_amd64_sha256}"
require_literal Dockerfile "ARG UNGOOGLED_CHROMIUM_ARM64_SHA256=${ungoogled_arm64_sha256}"
require_literal Dockerfile.market "ARG NODE_IMAGE=docker.io/library/node:24-trixie"
require_literal Dockerfile.market "ARG BASE_IMAGE=${image_repository}:${image_version}"
require_literal Dockerfile.market "ARG DSH_MARKET_VERSION=${market_version}"
require_literal Dockerfile.market "ARG MARKET_IMAGE_VERSION=${market_image_version}"
require_literal Dockerfile.bwrap "ARG BASE_IMAGE=${image_repository}:${image_version}"
require_literal Dockerfile.bwrap "ARG BWRAP_IMAGE_VERSION=${bwrap_image_version}"
require_literal Dockerfile.bwrap 'apt-get install --yes --no-install-recommends bubblewrap'
require_literal compose.yaml "DSH_IMAGE_VERSION:-${image_version}"
require_literal compose.yaml "DSH_IMAGE_REPOSITORY:-${image_repository}"
require_literal compose.yaml 'NODE_IMAGE:-docker.io/library/node:24-trixie'
require_literal compose.yaml 'DSH_BROWSER_USE_ENABLED: ${DSH_BROWSER_USE_ENABLED:-1}'
require_literal compose.market.yaml "MARKET_IMAGE_VERSION:-${market_image_version}"
require_literal compose.bwrap.yaml "BWRAP_IMAGE_VERSION:-${bwrap_image_version}"
require_literal compose.bwrap.yaml 'seccomp=unconfined'
require_literal compose.bwrap.yaml 'systempaths=unconfined'
require_literal compose.podman.yaml 'userns_mode: "keep-id:uid=1000,gid=1000"'
require_literal compose.podman.yaml 'in_pod: false'
require_literal compose.podman.yaml '${DSH_WORKSPACE:-dsh-workspace}:/workspace:Z'
require_literal .env.example "DSH_VERSION=${dsh_version}"
require_literal .env.example "DSH_IMAGE_VERSION=${image_version}"
require_literal .env.example "PNPM_VERSION=${pnpm_version}"
require_literal .env.example "DSH_IMAGE_REPOSITORY=${image_repository}"
require_literal .env.example 'NODE_IMAGE=docker.io/library/node:24-trixie'
require_literal charts/deepseek-harness/Chart.yaml "appVersion: \"${dsh_version}\""
require_literal charts/deepseek-harness/Chart.yaml "image: ${image_repository}:${image_version}"
require_literal charts/deepseek-harness/values.yaml "repository: ${image_repository}"
require_literal charts/deepseek-harness/values.yaml "tag: ${image_version}"
require_literal scripts/smoke.sh "${image_repository}:${image_version}"
require_literal scripts/smoke.sh "expected_version=\"\${2:-${dsh_version}}\""
require_literal scripts/dsh-container 'NARB_DISABLE_NATIVE_CACHE=1'
require_literal scripts/deepseek-harness-entrypoint 'node /opt/deepseek-harness/dsh-web-supervisor.cjs "$@" &'
require_literal scripts/deepseek-harness-entrypoint 'dsh-experimental-browser-use-playwright-mcp'
require_literal scripts/podman-smoke.sh "${image_repository}:${image_version}"
require_literal scripts/podman-smoke.sh "expected_dsh_version=\"\${2:-${dsh_version}}\""
require_literal scripts/podman-smoke.sh 'command -v podman-compose'
require_literal scripts/podman-smoke.sh 'podman-compose 1.6.0 or newer is required'
require_literal scripts/bwrap-smoke.sh "${image_repository}:${bwrap_image_version}"
require_literal scripts/bwrap-smoke.sh '--security-opt seccomp=unconfined'
require_literal scripts/bwrap-smoke.sh '--security-opt systempaths=unconfined'
require_literal .github/workflows/ci.yml "IMAGE_VERSION=${image_version}"
require_literal .github/workflows/ci.yml "MARKET_IMAGE_VERSION=${market_image_version}"
require_literal .github/workflows/ci.yml "IMAGE_VERSION=${ungoogled_image_version}"
require_literal .github/workflows/ci.yml "UNGOOGLED_CHROMIUM_VERSION=${ungoogled_chromium_version}"
require_literal .github/workflows/ci.yml "UNGOOGLED_CHROMIUM_AMD64_SHA256=${ungoogled_amd64_sha256}"
require_literal .github/workflows/ci.yml "UNGOOGLED_CHROMIUM_ARM64_SHA256=${ungoogled_arm64_sha256}"
require_literal .github/workflows/ci.yml "${dsh_version} ${pnpm_version} ${market_version}"
require_literal .github/workflows/ci.yml './scripts/podman-smoke.sh localhost/deepseek-harness:ci-amd64'
require_literal .github/workflows/ci.yml 'podman-compose/bin/podman-compose'
require_literal .github/workflows/ci.yml 'podman-compose==1.6.0'
require_literal .github/workflows/ci.yml "BWRAP_IMAGE_VERSION=${bwrap_image_version}"
require_literal .github/workflows/ci.yml './scripts/bwrap-smoke.sh deepseek-harness:ci-bwrap'
require_literal .github/workflows/ci.yml 'bwrap: Failed to make / slave: Permission denied'
# Publish workflows are disabled (no image is published). They must not carry
# version literals that could drift; the stale-release scan above still covers
# them, so no per-version assertion is needed here.
require_literal .github/workflows/publish-dockerhub.yml "DSH_VERSION: ${dsh_version}"
require_literal .github/workflows/publish-dockerhub.yml "IMAGE_VERSION: ${image_version}"
require_literal .github/workflows/publish-dockerhub.yml "MARKET_IMAGE_VERSION: ${market_image_version}"
require_literal .github/workflows/publish-dockerhub.yml "UNGOOGLED_IMAGE_VERSION: ${ungoogled_image_version}"
require_literal .github/workflows/publish-dockerhub.yml "BWRAP_IMAGE_VERSION: ${bwrap_image_version}"
require_literal .github/workflows/upstream-dsh.yml "./scripts/check-upstream-dsh.sh ${dsh_version}"
require_literal scripts/check-upstream-dsh.sh "pinned_version=\"\${1:-${dsh_version}}\""
require_literal plugins/dsh-browser-desktop/package.json "\"version\": \"${browser_plugin_version}\""
require_literal plugins/dsh-browser-desktop/package.json '"@deepseek-ai/dsh-client-modules"'
require_literal web.cordis.patch.yml "name: '@deepseek-ai/dsh-browser-use'"
require_literal web.cordis.patch.yml "name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'"
require_literal web.cordis.patch.yml "endpoint: 'http://127.0.0.1:9222'"
require_literal README.md "${image_repository}:${image_version}"
require_literal README.md "--build-arg DSH_VERSION=${dsh_version}"
require_literal README.md "DSH_VERSION=${dsh_version} DSH_IMAGE_VERSION=${image_version}"
require_literal README.md "${image_repository}:${market_image_version}"
require_literal README.md "${image_repository}:${ungoogled_image_version}"
require_literal README.md "${image_repository}:${bwrap_image_version}"
require_literal README.md "ungoogled-chromium@${ungoogled_chromium_version}"
require_literal README.md "runzhliu-dsh-browser-desktop-${browser_plugin_version}.tgz"
require_literal README.en.md "${image_repository}:${image_version}"
require_literal README.en.md "--build-arg DSH_VERSION=${dsh_version}"
require_literal README.en.md "DSH_VERSION=${dsh_version} DSH_IMAGE_VERSION=${image_version}"
require_literal README.en.md "${image_repository}:${market_image_version}"
require_literal README.en.md "${image_repository}:${ungoogled_image_version}"
require_literal README.en.md "${image_repository}:${bwrap_image_version}"
require_literal README.en.md "ungoogled-chromium@${ungoogled_chromium_version}"
require_literal README.en.md "runzhliu-dsh-browser-desktop-${browser_plugin_version}.tgz"
require_literal SKILL.md "${image_repository}:${image_version}"
require_literal SKILL.md "${ungoogled_image_version}"
require_literal SKILL.md "${bwrap_image_version}"
require_literal README.md 'compose.podman.yaml'
require_literal README.en.md 'compose.podman.yaml'
require_literal SKILL.md 'compose.podman.yaml'
require_literal README.md 'compose.bwrap.yaml'
require_literal README.en.md 'compose.bwrap.yaml'
require_literal SKILL.md 'compose.bwrap.yaml'

# Command-form pins in documentation. The tag assertions above pass as long as
# the tag appears somewhere in the file, so a copy-pasteable command can keep
# naming the previous release while the prose around it is already upgraded.
# Assert these exact command lines instead of scanning the whole file, because
# the same files must keep their historical screenshot captions.
require_literal README.md "export DSH_IMAGE_VERSION=${ungoogled_image_version}"
require_literal README.en.md "export DSH_IMAGE_VERSION=${ungoogled_image_version}"
require_literal SKILL.md "export DSH_IMAGE_VERSION=${ungoogled_image_version}"
require_literal README.md "--set image.tag=${image_version}"
require_literal README.en.md "--set image.tag=${image_version}"
require_literal README.md "--set image.tag=${market_image_version}"
require_literal README.en.md "--set image.tag=${market_image_version}"

# This repository publishes no images. Guard the policy at the level contributors
# actually read: no document may tell a reader to pull, and the publish
# workflows must keep their fail-closed guard step.
# Match a pull command only at the start of a code-block line: prose that
# explains a command is retired must stay allowed.
require_absent_command() {
  local file="$1" command_pattern="$2"
  if grep -E --quiet -- "^[[:space:]]*${command_pattern}" "${file}"; then
    printf 'publishing is disabled, but %s still instructs a pull-style command matching %s\n' \
      "${file}" "${command_pattern}" >&2
    return 1
  fi
}

for doc in README.md README.en.md SKILL.md; do
  require_absent_command "${doc}" 'docker compose pull'
  require_absent_command "${doc}" 'podman-compose -f compose.yaml -f compose.podman.yaml pull'
  require_absent_command "${doc}" 'docker pull '
done
for workflow in \
  .github/workflows/publish-dockerhub.yml \
  .github/workflows/publish-ghcr.yml \
  .github/workflows/dockerhub-description.yml; do
  require_literal "${workflow}" 'Refuse to run (publishing is disabled)'
done
require_literal CONTRIBUTING.md 'This repository does not publish images'

printf 'versions are consistent: image=%s dsh=%s pnpm=%s market=%s browser-plugin=%s ungoogled-chromium=%s bwrap=%s\n' \
  "${image_version}" "${dsh_version}" "${pnpm_version}" "${market_version}" "${browser_plugin_version}" "${ungoogled_chromium_version}" "${bwrap_image_version}"
