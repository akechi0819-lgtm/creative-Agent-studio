#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
NODE="$ROOT/.studio-runtime/node/node-v22.23.3-darwin-arm64/bin/node"

if [ ! -x "$NODE" ]; then
  printf '%s\n' '成品包内的 Node.js 缺失或不可执行，请重新解压完整成品包。' >&2
  exit 1
fi

exec "$NODE" "$ROOT/scripts/studio.mjs" "$@"
