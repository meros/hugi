#!/usr/bin/env bash
# Download the benchmark puzzles from webpbn.com into puzzles/webpbn/ (not in
# git: webpbn puzzles are copyright their designers, for personal use).
# Usage: scripts/fetch-webpbn.sh [list]   (default: puzzles/survey.list)
set -euo pipefail
list=${1:-puzzles/survey.list}
mkdir -p puzzles/webpbn
while read -r id name _; do
  case "$id" in ''|\#*) continue ;; esac
  out=$(printf 'puzzles/webpbn/%05d-%s.nin' "$id" "$name")
  [ -s "$out" ] && continue
  curl -sf -X POST -d "id=$id&fmt=nin&go=1" https://webpbn.com/export.cgi -o "$out"
  echo "$out"
  sleep 0.5   # be gentle with webpbn.com
done < "$list"
