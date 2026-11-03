#!/usr/bin/env bash
# Opens (or adds to) a GitHub issue when something needs Hasan, and closes it once fixed.
# GitHub emails the repository owner about new issues and comments, so this is the alert.
#
#   scripts/backup/alert.sh open  LABEL "Title" "Body"
#   scripts/backup/alert.sh close LABEL "Comment"
#
# Needs GH_TOKEN (the workflow's own token, with issues: write) and GH_REPO.
set -euo pipefail
MODE="$1"; LABEL="$2"
OPEN="$(gh issue list --label "$LABEL" --state open --json number --jq '.[0].number // empty')"

if [ "$MODE" = open ]; then
  TITLE="$3"; BODY="$4"
  if [ -n "$OPEN" ]; then
    gh issue comment "$OPEN" --body "Still happening. $BODY"
  else
    gh label create "$LABEL" --color B60205 --description "Opened automatically by a Depeche health check" --force >/dev/null
    gh issue create --label "$LABEL" --title "$TITLE" --body "@CodeMaster267 $BODY

This issue closes itself once the next run succeeds."
  fi
elif [ -n "$OPEN" ]; then
  gh issue close "$OPEN" --comment "$3"
fi
