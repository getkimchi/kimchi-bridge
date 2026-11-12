#!/usr/bin/env bash
# Re-sign a bun-compiled macOS binary (usage: codesign.sh <binary>). Adapted from kimchictl.
#
# bun --compile grafts the app payload onto a pre-signed runtime, which invalidates its signature,
# and the kernel kills badly-signed arm64 binaries outright (SIGKILL, exit 137) — see
# https://github.com/oven-sh/bun/issues/7208. Every darwin binary is therefore re-signed:
#   - CSC_NAME set (release CI, prepared by scripts/setup-codesign.sh): Developer ID with the
#     hardened runtime, a timestamp and build/entitlements.mac.plist. The designated requirement
#     anchors on the certificate, so every version is one identity to the keychain.
#   - CSC_NAME unset (forks, local builds): ad-hoc, enough for macOS to launch it.
set -euo pipefail

binary=${1:?usage: codesign.sh <binary>}
entitlements="$(cd "$(dirname "$0")/.." && pwd)/build/entitlements.mac.plist"

codesign --remove-signature "$binary"

if [[ -n "${CSC_NAME:-}" ]]; then
  codesign --sign "$CSC_NAME" --options runtime --timestamp --entitlements "$entitlements" "$binary"
  codesign --verify --strict --verbose=2 "$binary"
  # A cdhash-only requirement would make the keychain treat every version as a new program.
  if ! codesign -d -r- "$binary" 2>&1 | grep -q "anchor apple generic"; then
    echo "Designated requirement is not certificate-anchored; refusing to ship." >&2
    exit 1
  fi
else
  echo "CSC_NAME not set: ad-hoc signing (fork or local build)."
  codesign -s - "$binary"
  codesign --verify -v "$binary"
fi
