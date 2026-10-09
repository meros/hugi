#!/usr/bin/env bash
# Build the WebAssembly solver and put it next to the page: web/hugi_web.wasm.
# Needs a Rust toolchain with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown).
# Then serve web/ with any static file server, for example: python3 -m http.server -d web
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -p hugi-web --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/hugi_web.wasm web/hugi_web.wasm
ls -l web/hugi_web.wasm
