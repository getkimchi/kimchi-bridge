#!/usr/bin/env bash
# Prepare a throwaway keychain holding the Developer ID Application certificate, so
# scripts/codesign.sh signs non-interactively, and export CSC_NAME, the signing identity. Adapted
# from kimchictl.
#
# Inputs (GitHub secrets, passed via step env):
#   CSC_LINK         base64-encoded .p12 (certificate + private key)
#   CSC_KEY_PASSWORD password for the .p12
#
# Without CSC_LINK (forks, local runs) this does nothing and codesign.sh signs ad-hoc. With it,
# only disposable GitHub-hosted runners are supported: the keychain search list and default must
# persist into the signing step and are not restored.
set -euo pipefail

if [[ -z "${CSC_LINK:-}" ]]; then
  echo "CSC_LINK not set: macOS binaries will be ad-hoc signed."
  exit 0
fi

if [[ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "Developer ID setup requires a disposable GitHub-hosted runner; it changes user keychain state without restoring it." >&2
  exit 1
fi

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
KEYCHAIN="$RUNNER_TEMP/kimchi-signing.keychain-db"
KEYCHAIN_PW=$(openssl rand -hex 16)

security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
# Unlocked for the whole job (6h), however long the build takes.
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN" login.keychain-db
security default-keychain -s "$KEYCHAIN"

P12_PATH="$RUNNER_TEMP/developer-id.p12"
G2_PATH="$RUNNER_TEMP/DeveloperIDG2CA.cer"
trap 'rm -f "$P12_PATH" "$G2_PATH"' EXIT

echo "$CSC_LINK" | base64 -D -o "$P12_PATH"
security import "$P12_PATH" -k "$KEYCHAIN" -P "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD is required when CSC_LINK is set}" -A -T /usr/bin/codesign -T /usr/bin/security
rm -f "$P12_PATH"

# Let codesign use the imported key without a GUI prompt, which would hang the job (macOS 10.12+).
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null

# The Developer ID G2 intermediate, for building the chain during verification, in our keychain:
# no sudo, no writes to the shared System keychain. A duplicate import is fine.
curl -fsSL -o "$G2_PATH" "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"
security import "$G2_PATH" -k "$KEYCHAIN" -A || true
rm -f "$G2_PATH"

# Exactly one Developer ID Application identity, or a bad secret fails here, not mid-signing.
IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN")
MATCHES=$(awk '/Developer ID Application/ {count++} END {print count+0}' <<< "$IDENTITIES")
if [[ "$MATCHES" -ne 1 ]]; then
  echo "Expected exactly one 'Developer ID Application' identity after import, found $MATCHES; check CSC_LINK/CSC_KEY_PASSWORD." >&2
  printf '%s\n' "$IDENTITIES" >&2
  exit 1
fi
IDENTITY=$(awk -F '"' '/Developer ID Application/ {print $2}' <<< "$IDENTITIES")

echo "Signing identity: $IDENTITY"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "CSC_NAME=$IDENTITY" >> "$GITHUB_ENV"
else
  echo "CSC_NAME=$IDENTITY"
fi
