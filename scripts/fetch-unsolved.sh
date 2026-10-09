#!/usr/bin/env bash
# The two puzzles of Jan Wolter's survey that no solver finished within 30
# minutes (https://webpbn.com/survey/), in Simpson's .non format, from the
# Emacs nonogram package (https://github.com/emacsmirror/nonogram):
#   Knotty  40x40  "Knotty Puzzle", Joe Cooke (2013)
#   Faase   80x95  "Faase", Kerrin Mansfield (2006)
# The third, Meow, was replaced on webpbn by an easier version and is gone.
set -euo pipefail
mkdir -p puzzles/unsolved
base=https://raw.githubusercontent.com/emacsmirror/nonogram/master/puzzles
for f in 29-knotty 33-faase; do
  [ -s "puzzles/unsolved/$f.non" ] || curl -sf "$base/$f.non" -o "puzzles/unsolved/$f.non"
  echo "puzzles/unsolved/$f.non"
done
