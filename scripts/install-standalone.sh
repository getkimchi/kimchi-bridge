#!/bin/sh
# Installs kimchi-bridge without Kimchi: downloads this machine's binary from the GitHub release,
# checks it against the release's checksums and runs `kimchi-bridge install`, which puts the
# binary in place and adds the plugins to Claude Code and Codex. Released with the binaries, so it
# always matches them.
#
#   curl -fsSL https://github.com/getkimchi/kimchi-bridge/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- claude    # one client; default: every one installed
#
# KIMCHI_BRIDGE_VERSION pins a release tag. KIMCHI_BRIDGE_PREFIX and KIMCHI_BRIDGE_BIN_DIR move the
# install (default ~/.local/share/kimchi-bridge) and the command (default ~/.local/bin).
set -eu
umask 077
# Bun's switch would make the downloaded binary run as the bun command instead.
unset BUN_BE_BUN

repo=getkimchi/kimchi-bridge
fail() { printf '%s\n' "$*" >&2; exit 1; }
prefix=${KIMCHI_BRIDGE_PREFIX:-"$HOME/.local/share/kimchi-bridge"}
bin_dir=${KIMCHI_BRIDGE_BIN_DIR:-"$HOME/.local/bin"}
case "$prefix:$bin_dir" in /*:/*) ;; *) fail 'Install and binary directories must be absolute.' ;; esac

if [ $# -gt 0 ]; then
  client=$1
else
  # Without a choice, the plugins go to every client installed.
  client=
  if command -v claude >/dev/null 2>&1; then client=claude; fi
  if command -v codex >/dev/null 2>&1; then
    if [ -n "$client" ]; then client=both; else client=codex; fi
  fi
  [ -n "$client" ] || fail 'Install Claude Code or Codex first: kimchi-bridge adds its plugins to them.'
fi
case "$client" in claude|codex|both) ;; *) fail 'Choose claude, codex or both.' ;; esac

version=${KIMCHI_BRIDGE_VERSION:-}
case "$version" in
  "") base=https://github.com/$repo/releases/latest/download ;;
  v*[!0-9A-Za-z.-]*) fail "Invalid release tag: $version" ;;
  v?*) base=https://github.com/$repo/releases/download/$version ;;
  *) fail "Invalid release tag: $version" ;;
esac

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "kimchi-bridge has no build for $(uname -s)." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "kimchi-bridge has no build for $(uname -m)." ;;
esac
# A shell Rosetta 2 translates reports x86_64; the Mac runs the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
asset=kimchi-bridge-$os-$arch

command -v curl >/dev/null 2>&1 || fail 'Installing needs curl.'
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail 'Installing needs sha256sum or shasum to check the download.'
fi

# The download runs from the install directory, not a temporary one that may forbid running
# programs, and leaves nothing behind.
mkdir -p "$prefix"
download=$(mktemp -d "$prefix/.download.XXXXXXXX")
trap 'rm -rf -- "$download"' EXIT
fetch() {
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$download/$1" "$base/$1" ||
    fail "Could not download $base/$1"
}
printf 'Downloading %s\n' "$base/$asset"
fetch "$asset"
fetch checksums.txt
expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$download/checksums.txt")
[ -n "$expected" ] || fail "The release lists no checksum for $asset."
[ "$(sha256 "$download/$asset")" = "$expected" ] ||
  fail "$asset does not match the release's checksum; nothing was installed."
chmod 700 "$download/$asset"
# The binary copies itself to $prefix/bin and registers the plugins through its install.sh. A
# binary that cannot run here stops before anything is in place.
"$download/$asset" install "$client" || fail 'kimchi-bridge install failed; see above.'
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to your PATH to run kimchi-bridge.\n' "$bin_dir" ;; esac
