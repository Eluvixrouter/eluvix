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
#
# Notes:
#   - Argument parsing, the cd to the repo root, and the --dry-run exit all
#     happen BEFORE the test suite runs (hunt-2 L3): invoking the script
#     from outside the repo, or with --dry-run, must not run tests first.
#   - If the requested version already equals the current version and its
#     tag is missing, the tag is created without touching any files
#     (hunt-2 L6) — this is the recovery path for a bump that was never
#     tagged (e.g. 1.0.5, whose bump commit exists but was never tagged).
#   - After a successful bump, add a CHANGELOG.md entry for the new version
#     (see CHANGELOG.md's header for the process, hunt-2 M12).
# ==============================================================================

set -euo pipefail

# --- Resolve the repo root first, so every later step (including tests)
# --- runs against this repo even when the script is invoked from elsewhere.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

VERSION_FILE="${REPO_ROOT}/VERSION"

# --- Parse arguments before doing any work (hunt-2 L3). ---
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

PACKAGES=(
  "package.json"
  "apps/desktop/package.json"
  "packages/router-core/package.json"
  "packages/opencode-eluvix/package.json"
  "apps/nextjs/package.json"
  "apps/githubio/package.json"
)

# --- Resolve the current version WITHOUT writing anything (hunt-2 L3, and
# --- the known dry-run side effect where resolution created VERSION when it
# --- was absent). Every version source must agree; on divergence, fail
# --- loudly instead of silently picking one (hunt-2 L4). Plain indexed
# --- arrays only — no associative arrays, so the script still runs on the
# --- bash 3.2 macOS ships. ---
VERSION_REPORT=""
CURRENT_VERSION=""
check_version_source() {
  # $1 = label, $2 = value
  VERSION_REPORT="${VERSION_REPORT}  ${1}: ${2}
"
  if [ -z "${CURRENT_VERSION}" ]; then
    CURRENT_VERSION="${2}"
  elif [ "${2}" != "${CURRENT_VERSION}" ]; then
    echo "Error: Version sources disagree; refusing to pick a bump base (hunt-2 L4)." >&2
    printf '%s' "${VERSION_REPORT}" >&2
    echo "Align VERSION, all package.json files, and helm/eluvix/Chart.yaml appVersion, then re-run." >&2
    exit 1
  fi
}
if [ -f "${VERSION_FILE}" ]; then
  check_version_source "VERSION" "$(tr -d "[:space:]" < "${VERSION_FILE}")"
fi
for pkg in "${PACKAGES[@]}"; do
  if [ -f "${pkg}" ]; then
    check_version_source "${pkg}" "$(node -p "require('./${pkg}').version")"
  fi
done
if [ -f helm/eluvix/Chart.yaml ]; then
  check_version_source "helm/eluvix/Chart.yaml (appVersion)" "$(grep '^appVersion:' helm/eluvix/Chart.yaml | head -n 1 | sed 's/^appVersion: *//; s/"//g; s/ *$//')"
fi

if [ -z "${CURRENT_VERSION}" ]; then
  echo "Error: No version source found (no VERSION file, package.json, or Chart.yaml)." >&2
  exit 1
fi
if [[ ! "${CURRENT_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "Error: Current version \"${CURRENT_VERSION}\" is not a valid x.y.z version." >&2
  exit 1
fi

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
    # Hunt-2 L5: a v-prefixed argument gets the same numeric validation
    # as a bare version — the prefix is not a free pass for malformed input.
    NEW_VERSION="${TARGET_ARG#v}"
    if [[ ! "${NEW_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+.*$ ]]; then
      echo "Error: Unknown argument \"${TARGET_ARG}\"." >&2
      echo "Usage: $0 [patch|minor|major|<version>] [--push] [--dry-run]" >&2
      exit 1
    fi
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

# Release tags are signed (git tag -s). Fail fast, before mutating
# anything, if no signing key is configured. This must precede the
# missing-tag path below, which also creates a (signed) tag — but a
# dry run creates nothing, so it must not fail on a missing key.
if [ "${DRY_RUN}" != true ]; then
  SIGNING_KEY="$(git config user.signingkey || true)"
  if [ -z "${SIGNING_KEY}" ]; then
    echo "Error: git user.signingkey is not configured — release tags must be signed."
    echo "Configure it with your GPG key id, for example:"
    echo "  git config user.signingkey <KEYID>"
    echo "(List your keys with: gpg --list-secret-keys --keyid-format long)"
    exit 1
  fi
fi

# Hunt-2 L6: the requested version is already the current version, but its
# tag is missing (the tag-existence check above already ruled out the
# tag-present case). There are no files to change and nothing to commit,
# so create just the tag instead of failing on an empty commit.
if [ "${NEW_VERSION}" = "${CURRENT_VERSION}" ]; then
  if [ "${DRY_RUN}" = true ]; then
    echo ">> Dry run: already at version ${CURRENT_VERSION}; would create missing tag ${TAG_NAME} and change no files."
    exit 0
  fi
  echo ">> Already at version ${CURRENT_VERSION}; creating missing tag ${TAG_NAME} (no files changed)."
  git tag -s "${TAG_NAME}" -m "Release ${TAG_NAME}"
  if [ "${PUSH_FLAG}" = true ]; then
    echo ">> Pushing tag to origin..."
    git push origin "${TAG_NAME}"
  else
    echo ""
    echo "To trigger GitHub Actions to build and release the Electron app, push:"
    echo "  git push origin ${TAG_NAME}"
    echo ""
  fi
  echo "============================================================"
  echo " Created missing tag ${TAG_NAME} for existing version ${CURRENT_VERSION}."
  echo "============================================================"
  exit 0
fi

if [ "${DRY_RUN}" = true ]; then
  echo ">> Dry run complete. No files changed, no tags created."
  exit 0
fi

# Tests gate the writes, but they run only after argument parsing, the cd,
# version validation, and the dry-run exit above (hunt-2 L3).
pnpm test

echo ">> Updating VERSION file..."
echo "${NEW_VERSION}" > "${VERSION_FILE}"

echo ">> Updating package.json files..."
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

echo ">> Creating signed git tag ${TAG_NAME}..."
git tag -s "${TAG_NAME}" -m "Release ${TAG_NAME}"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "============================================================"
echo " Successfully created release ${TAG_NAME}!"
echo " Commit: $(git rev-parse --short HEAD)"
echo " Tag:    ${TAG_NAME}"
echo "============================================================"
echo " Remember: add a CHANGELOG.md entry for ${TAG_NAME} (see its header"
echo " for the process) before the release is announced."

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
