#!/usr/bin/env bash
# Profile-guided build: instrumented binary, a training run, then the final
# binary at target-pgo/release/hugi. Needs llvm-profdata from the same
# LLVM major version as rustc (`rustc -vV`). Measured 2026-10-09: the
# learning solver on Gettys 1.36x faster, the probing search up to 1.1x.
#
# The training covers both engines and the portfolio: the survey puzzles
# (scripts/fetch-webpbn.sh first, if they are there) and generated random
# puzzles, which need nothing downloaded.
set -euo pipefail
cd "$(dirname "$0")/.."
prof=$(mktemp -d)
trap 'rm -rf "$prof"' EXIT
flags="-C target-cpu=native"
RUSTFLAGS="$flags -Cprofile-generate=$prof/raw" cargo build --release -q --target-dir target-pgo-gen
bin=target-pgo-gen/release/hugi
train=()
for f in puzzles/heart.txt puzzles/webpbn/*.nin; do [ -e "$f" ] && train+=("$f"); done
for seed in 1 2 3 4 5 6; do
  "$bin" gen 30 30 50 "$seed" > "$prof/r30-$seed.txt"; train+=("$prof/r30-$seed.txt")
done
for seed in 6008 6009 7003; do
  "$bin" gen 50 50 50 "$seed" > "$prof/r50-$seed.txt"; train+=("$prof/r50-$seed.txt")
done
for f in "${train[@]}"; do
  timeout 60 "$bin" "$f" > /dev/null || true                  # portfolio
  timeout 60 "$bin" "$f" --threads 1 > /dev/null || true      # probing search
  timeout 30 "$bin" "$f" --cdcl > /dev/null || true           # learning solver
  NONO_SEED=1 timeout 30 "$bin" "$f" --cdcl > /dev/null || true     # strategy 1
done
llvm-profdata merge -o "$prof/merged.profdata" "$prof/raw"
RUSTFLAGS="$flags -Cprofile-use=$prof/merged.profdata" cargo build --release -q --target-dir target-pgo
echo target-pgo/release/hugi
