#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
NODE="$("$ROOT/scripts/bootstrap-node.sh" "$ROOT")"

if [ "$#" -eq 0 ]; then
  exec "$NODE" "$ROOT/scripts/launcher.mjs" menu
fi
exec "$NODE" "$ROOT/scripts/launcher.mjs" "$@"
