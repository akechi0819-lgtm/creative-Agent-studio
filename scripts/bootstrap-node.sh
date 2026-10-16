#!/bin/sh
set -eu

ROOT="$1"
PINNED_VERSION="22.23.3"
RUNTIME_ROOT="$ROOT/.studio-runtime/node"

node_is_supported() {
  candidate="$1"
  [ -x "$candidate" ] || return 1
  "$candidate" -e 'const version = process.versions.node; const [major, minor] = version.split(".").map(Number); process.exit(/^\d+\.\d+\.\d+$/.test(version) && ((major === 22 && minor >= 19) || major >= 24) ? 0 : 1)' >/dev/null 2>&1 || return 1
  npm_command="$(command -v npm 2>/dev/null || true)"
  [ -n "$npm_command" ] || return 1
  case "$npm_command" in
    /*) [ -x "$npm_command" ] || return 1 ;;
  esac
  return 0
}

system_node="$(command -v node 2>/dev/null || true)"
if [ -n "$system_node" ] && node_is_supported "$system_node"; then
  printf '%s\n' "$system_node"
  exit 0
fi

case "$(uname -s)" in
  Darwin) ;;
  *) printf '%s\n' "Unsupported platform for Start.command; use Start.cmd on Windows." >&2; exit 2 ;;
esac

case "$(uname -m)" in
  arm64|aarch64)
    ARCH="arm64"
    EXPECTED_SHA256="72d5d8832b41c9d9646197af614ffd751406ea4d215060eb91b98864e1919a3e"
    ;;
  x86_64|amd64)
    ARCH="x64"
    EXPECTED_SHA256="ac41874c3352937119cfec39e1a98c578fe58ce8a86d7e785b89a4706015f305"
    ;;
  *) printf 'Unsupported macOS architecture: %s\n' "$(uname -m)" >&2; exit 2 ;;
esac

ARCHIVE_NAME="node-v${PINNED_VERSION}-darwin-${ARCH}.tar.xz"
TARGET="$RUNTIME_ROOT/node-v${PINNED_VERSION}-darwin-${ARCH}"
NODE="$TARGET/bin/node"
if [ -x "$NODE" ] && "$NODE" -e 'const version = process.versions.node; const [major, minor] = version.split(".").map(Number); process.exit(/^\d+\.\d+\.\d+$/.test(version) && major === 22 && minor >= 19 ? 0 : 1)' >/dev/null 2>&1; then
  printf '%s\n' "$NODE"
  exit 0
fi

mkdir -p "$RUNTIME_ROOT"
TMP="$RUNTIME_ROOT/.install-${ARCH}-$$"
ARCHIVE="$TMP/$ARCHIVE_NAME"
EXTRACTED="$TMP/extracted"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM
rm -rf "$TMP" "$TARGET"
mkdir -p "$TMP" "$EXTRACTED"

URL="https://nodejs.org/download/release/v${PINNED_VERSION}/${ARCHIVE_NAME}"
printf 'Downloading private Node.js %s runtime for macOS %s...\n' "$PINNED_VERSION" "$ARCH" >&2
curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 30 --max-time 180 --proto '=https' --tlsv1.2 --output "$ARCHIVE" "$URL"
ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  printf 'Node.js archive checksum mismatch: expected %s, received %s\n' "$EXPECTED_SHA256" "$ACTUAL_SHA256" >&2
  exit 1
fi

tar -xJf "$ARCHIVE" --strip-components=1 -C "$EXTRACTED"
mkdir -p "$RUNTIME_ROOT"
mv "$EXTRACTED" "$TARGET"
if [ ! -x "$NODE" ]; then
  printf '%s\n' 'The verified Node.js archive did not contain bin/node.' >&2
  exit 1
fi
printf 'Installed private Node.js %s at %s\n' "$PINNED_VERSION" "$NODE" >&2
printf '%s\n' "$NODE"
