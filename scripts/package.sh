#!/usr/bin/env bash
set -euo pipefail
version=${1:?Usage: scripts/package.sh vVERSION OUTPUT_DIRECTORY}
out=${2:?Output directory required}
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo 'Invalid version' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)
temp=$(mktemp -d)
trap 'rm -rf -- "$temp"' EXIT
market="kimchi-work-${version//./-}"
for platform in ${PLATFORMS:-darwin/arm64 darwin/amd64 linux/amd64 linux/arm64}; do
  os=${platform%/*};arch=${platform#*/}
  stage="$temp/${os}_${arch}"
  mkdir -p "$stage/bin" "$stage/plugins" "$stage/.claude-plugin" "$stage/.agents/plugins"
  (cd "$root" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$stage/bin/kimchi-adapters" ./cmd/kimchi-adapters)
  cp -R "$root/plugins/claude" "$root/plugins/codex" "$stage/plugins/"
  for harness in claude codex; do
    mkdir -p "$stage/plugins/$harness/bin"
    cp "$stage/bin/kimchi-adapters" "$stage/plugins/$harness/bin/kimchi-adapters"
  done
  # Versions are release input, not an edit to the checked-in plugin source.
  sed -i.bak "s/\"version\":\"[^\"]*\"/\"version\":\"${version#v}\"/" "$stage/plugins/claude/.claude-plugin/plugin.json" "$stage/plugins/codex/.codex-plugin/plugin.json"
  rm "$stage/plugins/claude/.claude-plugin/plugin.json.bak" "$stage/plugins/codex/.codex-plugin/plugin.json.bak"
  printf '{"name":"%s","owner":{"name":"Kimchi"},"plugins":[{"name":"kimchi-work","source":"./plugins/claude","version":"%s","description":"Quiet work accounting for official Claude Code"}]}\n' "$market" "${version#v}" > "$stage/.claude-plugin/marketplace.json"
  printf '{"name":"%s","plugins":[{"name":"kimchi-work","source":{"source":"local","path":"./plugins/codex"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]}\n' "$market" > "$stage/.agents/plugins/marketplace.json"
  printf '%s\n' "$version" > "$stage/VERSION"
  cp "$root/install.sh" "$stage/install.sh"
  cp "$root/install.sh" "$stage/bootstrap.sh"
  COPYFILE_DISABLE=1 tar -czf "$out/kimchi-adapters_${os}_${arch}.tar.gz" -C "$stage" .
done
cp "$root/install.sh" "$out/install.sh"
(cd "$out" && if command -v sha256sum >/dev/null; then sha256sum kimchi-adapters_*.tar.gz > SHA256SUMS; else shasum -a 256 kimchi-adapters_*.tar.gz > SHA256SUMS; fi)
