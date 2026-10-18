#!/usr/bin/env bash
# ==============================================================================
# Eluvix Monorepo & Electron Desktop App Release Tagger
# ==============================================================================
# Usage:
#   ./scripts/release-tagger.sh patch         # e.g. 1.0.1 -> 1.0.2
#   ./scripts/release-tagger.sh minor         # e.g. 1.0.1 -> 1.1.0
#   ./scripts/release-tagger.sh major         # e.g. 1.0.1 -> 2.0.0
#   ./scripts/release-tagger.sh 1.0.2         # Explicit version
#   ./scripts/release-tagger.sh patch --push  # Also push commits & tag to origin
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

VERSION_FILE="${REPO_ROOT}/VERSION"

# Resolve current version prioritizing apps/desktop/package.json or VERSION file
if [ -f "${VERSION_FILE}" ]; then
  CURRENT_VERSION=$(tr -d "[:space:]" < "${VERSION_FILE}")
elif [ -f "${REPO_ROOT}/apps/desktop/package.json" ]; then
  CURRENT_VERSION=$(node -p "require('./apps/desktop/package.json').version")
  echo "${CURRENT_VERSION}" > "${VERSION_FILE}"
else
  CURRENT_VERSION=$(node -p "require('./package.json').version")
  echo "${CURRENT_VERSION}" > "${VERSION_FILE}"
fi

TARGET_ARG="patch"
PUSH_FLAG=false
DRY_RUN=false

for arg in "$@"; do
  if [ "$arg" == "--push" ] || [ "$arg" == "-p" ]; then
    PUSH_FLAG=true
  elif [ "$arg" == "--dry-run" ] || [ "$arg" == "-d" ]; then
    DRY_RUN=true
  else
    TARGET_ARG="$arg"
  fi
done

IFS="." read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"
PATCH="${PATCH%%-*}"

case "${TARGET_ARG}" in
  patch)
    NEW_PATCH=$((PATCH + 1))
    NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"
    ;;
  minor)
    NEW_MINOR=$((MINOR + 1))
    NEW_VERSION="${MAJOR}.${NEW_MINOR}.0"
    ;;
  major)
    NEW_MAJOR=$((MAJOR + 1))
    NEW_VERSION="${NEW_MAJOR}.0.0"
    ;;
  v*)
    NEW_VERSION="${TARGET_ARG#v}"
    ;;
  *)
    if [[ "${TARGET_ARG}" =~ ^[0-9]+\.[0-9]+\.[0-9]+.*$ ]]; then
      NEW_VERSION="${TARGET_ARG}"
    else
      echo "Error: Unknown argument \"${TARGET_ARG}\"."
      echo "Usage: $0 [patch|minor|major|<version>] [--push] [--dry-run]"
      exit 1
    fi
    ;;
esac

TAG_NAME="v${NEW_VERSION}"

echo "============================================================"
echo " Eluvix Release Tagger"
echo " Current Version: ${CURRENT_VERSION}"
echo " New Version:     ${NEW_VERSION} (${TAG_NAME})"
echo "============================================================"

if git rev-parse "${TAG_NAME}" >/dev/null 2>&1; then
  echo "Error: Tag ${TAG_NAME} already exists in git!"
  exit 1
fi

if [ "${DRY_RUN}" = true ]; then
  echo ">> Dry run complete. No files changed, no tags created."
  exit 0
fi

echo ">> Updating VERSION file..."
echo "${NEW_VERSION}" > "${VERSION_FILE}"

echo ">> Updating package.json files..."
PACKAGES=(
  "package.json"
  "apps/desktop/package.json"
  "packages/router-core/package.json"
  "apps/nextjs/package.json"
  "apps/githubio/package.json"
)

for pkg in "${PACKAGES[@]}"; do
  if [ -f "${pkg}" ]; then
    node -e "
      const fs = require('fs');
      const p = '${pkg}';
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      json.version = '${NEW_VERSION}';
      fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
    "
    echo "   ✓ Updated ${pkg}"
  fi
done

echo ">> Updating Helm chart version if present..."
if [ -f helm/eluvix/Chart.yaml ]; then
  sed -i -E "s/^appVersion: .*/appVersion: \"${NEW_VERSION}\"/" helm/eluvix/Chart.yaml
  sed -i -E "s/^version: .*/version: ${NEW_VERSION}/" helm/eluvix/Chart.yaml
  echo "   ✓ Updated helm/eluvix/Chart.yaml"
fi

echo ">> Staging and creating git commit..."
STAGED_FILES=("VERSION")
for pkg in "${PACKAGES[@]}"; do
  if [ -f "${pkg}" ]; then
    STAGED_FILES+=("${pkg}")
  fi
done
if [ -f helm/eluvix/Chart.yaml ]; then
  STAGED_FILES+=("helm/eluvix/Chart.yaml")
fi

git add "${STAGED_FILES[@]}"
git commit -m "chore(release): bump version to ${NEW_VERSION}"

echo ">> Creating git tag ${TAG_NAME}..."
git tag -a "${TAG_NAME}" -m "Release ${TAG_NAME}"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "============================================================"
echo " Successfully created release ${TAG_NAME}!"
echo " Commit: $(git rev-parse --short HEAD)"
echo " Tag:    ${TAG_NAME}"
echo "============================================================"

if [ "${PUSH_FLAG}" = true ]; then
  echo ">> Pushing branch and tag to origin..."
  git push origin "${CURRENT_BRANCH}"
  git push origin "${TAG_NAME}"
  echo ">> Pushed! GitHub Actions workflow \"Build Desktop Application\" will now build Electron binaries and publish to GitHub Releases for ${TAG_NAME}."
else
  echo ""
  echo "To trigger GitHub Actions to build and release the Electron app, push:"
  echo "  git push origin ${CURRENT_BRANCH}"
  echo "  git push origin ${TAG_NAME}"
  echo ""
  echo "Or re-run with --push next time:"
  echo "  ./scripts/release-tagger.sh [patch|minor|major] --push"
fi
