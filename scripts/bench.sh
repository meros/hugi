#!/usr/bin/env bash
# Solve every puzzle in puzzles/webpbn with a time limit each.
# Usage: scripts/bench.sh [seconds-per-puzzle] [extra solver flags...]
set -u
limit=${1:-60}; shift || true
bin=./target/release/hugi
printf '%-26s %8s %10s  %s\n' puzzle ms nodes result
for f in puzzles/webpbn/*.nin; do
  start=$(date +%s%N)
  out=$(timeout "$limit" "$bin" "$f" "$@" 2>&1); code=$?
  ms=$(( ($(date +%s%N) - start) / 1000000 ))
  if [ $code -eq 124 ]; then
    printf '%-26s %8s %10s  %s\n' "$(basename "$f" .nin)" ">${limit}s" - timeout
  else
    nodes=$(grep -o '[0-9]* search nodes' <<<"$out" | cut -d' ' -f1)
    res=$(grep -E 'unique|no solution' <<<"$out")
    printf '%-26s %8s %10s  %s\n' "$(basename "$f" .nin)" "$ms" "$nodes" "$res"
  fi
done
