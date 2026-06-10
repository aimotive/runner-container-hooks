#!/usr/bin/env bash
#
# Build the actions-runner image with the custom k8s-novolume hook baked in.
# Cross-builds for linux/amd64 so it can be built on an Apple-silicon / macOS
# host and run on the linux/amd64 cluster nodes.
#
# Usage:
#   ./build-novolume-runner.sh             # build + load into local docker
#   PUSH=true ./build-novolume-runner.sh   # build + push to the registry
#   TAG=v2.335.1-hooks5 ./build-novolume-runner.sh   # override the tag
#
# Env overrides: REGISTRY, IMAGE, TAG, PLATFORM, PUSH, BASE_IMAGE
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REGISTRY="${REGISTRY:-registry.example.com}"
IMAGE="${IMAGE:-actions-runner}"
TAG="${TAG:-v2.335.1-hooks5}"
PLATFORM="${PLATFORM:-linux/amd64}"
PUSH="${PUSH:-false}"
# Base runner image: official upstream by default; override to use a mirror.
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/actions/actions-runner:v2.335.1}"

IMAGE_REF="${REGISTRY}/${IMAGE}:${TAG}"

echo ">> Building ${IMAGE_REF}"
echo ">> Base image: ${BASE_IMAGE}"
echo ">> Platform: ${PLATFORM}  (host arch: $(uname -m))"
echo ">> Push:     ${PUSH}"

# buildx is required for --platform cross-builds. Ensure a builder exists.
if ! docker buildx inspect >/dev/null 2>&1; then
  echo ">> Creating buildx builder 'novolume-builder'"
  docker buildx create --name novolume-builder --use >/dev/null
fi

build_args=(
  buildx build
  --platform "${PLATFORM}"
  --build-arg "BASE_IMAGE=${BASE_IMAGE}"
  -f "${SCRIPT_DIR}/Dockerfile.novolume-runner"
  -t "${IMAGE_REF}"
)

if [[ "${PUSH}" == "true" ]]; then
  build_args+=(--push)
else
  # --load imports the single-platform result into the local docker engine.
  build_args+=(--load)
fi

docker "${build_args[@]}" "${SCRIPT_DIR}"

echo ">> Done: ${IMAGE_REF}"
if [[ "${PUSH}" != "true" ]]; then
  echo ">> Loaded locally. Push it with: PUSH=true TAG=${TAG} ${BASH_SOURCE[0]}"
fi
