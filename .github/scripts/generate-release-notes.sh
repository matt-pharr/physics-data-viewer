#!/usr/bin/env bash
#
# Generates release-notes.md for a published release.
#
# Required environment variables:
#   TAG       - the release tag (e.g. v0.0.12)
#   REPO      - "owner/repo"
#   GH_TOKEN  - GitHub token with read access
#
# Output: writes release-notes.md to the current working directory.

set -euo pipefail

VERSION="${TAG#v}"
OWNER="${REPO%/*}"
REPO_NAME="${REPO#*/}"

# ---------------------------------------------------------------------------
# 1. Standard PR-based changelog from GitHub's generate-notes endpoint.
# ---------------------------------------------------------------------------
CHANGELOG=$(gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/releases/generate-notes" \
  -f tag_name="${TAG}" \
  --jq .body)

# Split into the body (heading + PR list) and the trailing "Full Changelog" line
# so we can insert the Issues Addressed section between them.
CHANGELOG_BODY="${CHANGELOG%%\*\*Full Changelog\*\**}"
# Trim trailing blank lines
while [[ "${CHANGELOG_BODY}" == *$'\n' ]]; do
  CHANGELOG_BODY="${CHANGELOG_BODY%$'\n'}"
done
CHANGELOG_FOOTER=$(printf '%s\n' "$CHANGELOG" | grep -E '^\*\*Full Changelog\*\*' || true)

# ---------------------------------------------------------------------------
# 2. Walk PRs merged since the previous release, collect closed issues, and
#    bucket them by label.
# ---------------------------------------------------------------------------
PREV_TAG=$(gh api "/repos/${REPO}/releases" \
  --jq "[.[] | select(.draft==false and .prerelease==false and .tag_name != \"${TAG}\")] | .[0].tag_name // empty")

MAJOR_FILE=$(mktemp)
MINOR_FILE=$(mktemp)
SEEN_FILE=$(mktemp)
trap 'rm -f "$MAJOR_FILE" "$MINOR_FILE" "$SEEN_FILE"' EXIT

if [ -n "$PREV_TAG" ]; then
  PR_NUMBERS=$(gh api "/repos/${REPO}/compare/${PREV_TAG}...${TAG}" \
    --jq '.commits[].commit.message' \
    | grep -oE '#[0-9]+' \
    | tr -d '#' \
    | sort -u || true)

  for PR in $PR_NUMBERS; do
    # Commit messages may reference issue numbers as well as PR numbers.
    # When the number is not a PR, GraphQL returns an `errors` array and
    # `gh api` dumps the raw response to stdout while exiting non-zero —
    # we must discard that stdout so it isn't treated as a valid node.
    ISSUES_JSON=$(gh api graphql \
      -f query='
        query($owner: String!, $repo: String!, $pr: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pr) {
              closingIssuesReferences(first: 20) {
                nodes {
                  number
                  title
                  url
                  labels(first: 20) { nodes { name } }
                }
              }
            }
          }
        }' \
      -F owner="$OWNER" -F repo="$REPO_NAME" -F pr="$PR" \
      --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[]? | @json' \
      2>/dev/null) || ISSUES_JSON=""
    printf '%s\n' "$ISSUES_JSON" | while IFS= read -r issue; do
        [ -z "$issue" ] && continue
        NUM=$(echo "$issue" | jq -r '.number')
        if grep -qx "$NUM" "$SEEN_FILE" 2>/dev/null; then
          continue
        fi
        echo "$NUM" >> "$SEEN_FILE"
        TITLE=$(echo "$issue" | jq -r '.title')
        URL=$(echo "$issue" | jq -r '.url')
        if echo "$issue" | jq -e '.labels.nodes[] | select(.name=="major")' >/dev/null; then
          echo "* ${TITLE} ([#${NUM}](${URL}))" >> "$MAJOR_FILE"
        else
          echo "* ${TITLE} ([#${NUM}](${URL}))" >> "$MINOR_FILE"
        fi
      done
  done
fi

# ---------------------------------------------------------------------------
# 3. Build the Issues Addressed section (omitted entirely if no issues).
# ---------------------------------------------------------------------------
ISSUES_SECTION=""
if [ -s "$MAJOR_FILE" ] || [ -s "$MINOR_FILE" ]; then
  ISSUES_SECTION+=$'\n\n## Issues Addressed\n'
  if [ -s "$MAJOR_FILE" ]; then
    ISSUES_SECTION+=$'\n### Major\n\n'
    ISSUES_SECTION+="$(cat "$MAJOR_FILE")"
    ISSUES_SECTION+=$'\n'
  fi
  if [ -s "$MINOR_FILE" ]; then
    ISSUES_SECTION+=$'\n### Minor\n\n'
    ISSUES_SECTION+="$(cat "$MINOR_FILE")"
    ISSUES_SECTION+=$'\n'
  fi
fi

# ---------------------------------------------------------------------------
# 4. Assemble the final release notes file.
# ---------------------------------------------------------------------------
cat > release-notes.md <<EOF
## Downloads

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | \`PDV-${VERSION}-arm64.dmg\` |
| Linux (portable) | \`PDV-${VERSION}.AppImage\` |
| Linux (Debian/Ubuntu) | \`physics-data-viewer_${VERSION}_amd64.deb\` |
| Linux (Fedora/RHEL) | \`PDV-${VERSION}.x86_64.rpm\` |

> Other assets (\`.yml\`, \`.blockmap\`, \`.zip\`) are used internally by the auto-updater.

---

${CHANGELOG_BODY}${ISSUES_SECTION}

${CHANGELOG_FOOTER}
EOF
