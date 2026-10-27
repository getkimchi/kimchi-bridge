#!/usr/bin/env bash
set -euo pipefail

# Native plugin management for the package in Kimchi's release. No inference settings.
umask 077
prefix=${KIMCHI_ADAPTERS_PREFIX:-"$HOME/.local/share/kimchi-adapters"}
bin_dir=${KIMCHI_ADAPTERS_BIN_DIR:-"$HOME/.local/bin"}
action=${1:-install}
client=${2:-both}
requested=${3:-}
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$action" in install|update|uninstall|status) ;; *) fail 'Usage: install.sh install|update|uninstall|status claude|codex|both [vVERSION]' ;; esac
case "$client" in claude|codex|both) ;; *) fail 'Choose claude, codex or both.' ;; esac
case "$prefix:$bin_dir" in /*:/*) ;; *) fail 'Install and binary directories must be absolute.' ;; esac
# Releases are vMAJOR.MINOR.PATCH with an optional -rc.N suffix.
valid_version() {
  local core="${1#v}" rc=0
  [[ "v$core" == "$1" ]] || return 1
  case "$core" in *-rc.*) rc="${core#*-rc.}"; core="${core%%-rc.*}" ;; esac
  case "$core" in .*|*.|*..*|*.*.*.*|*[!0123456789.]*) return 1 ;; *.*.*) ;; *) return 1 ;; esac
  case "$rc" in ""|*[!0123456789]*) return 1 ;; esac
}
clients=()
[[ "$client" == codex ]] || clients+=(claude)
[[ "$client" == claude ]] || clients+=(codex)

if [[ "$action" == status ]]; then
  for cli in "${clients[@]}"; do
    if [[ -f "$prefix/installed/$cli" ]]; then printf '%s: %s\n' "$cli" "$(cat "$prefix/installed/$cli")"; else printf '%s: not installed\n' "$cli"; fi
  done
  [[ ! -x "$bin_dir/kimchi-adapters" ]] || "$bin_dir/kimchi-adapters" status
  exit 0
fi
for cli in "${clients[@]}"; do command -v "$cli" >/dev/null || fail "Install official $cli first."; done
mkdir -p "$prefix/installed" "$bin_dir"
if [[ "$action" != uninstall && ( -e "$bin_dir/kimchi-adapters" || -L "$bin_dir/kimchi-adapters" ) ]]; then
  existing=$(readlink "$bin_dir/kimchi-adapters") || fail 'Refusing to replace an unmanaged kimchi-adapters binary.'
  case "$existing" in "$prefix/releases/"*/bin/kimchi-adapters) ;; *) fail 'Refusing to replace an unmanaged kimchi-adapters link.' ;; esac
fi
mkdir "$prefix/install.lock" 2>/dev/null || fail "Another installer is running ($prefix/install.lock)."
trap 'rmdir "$prefix/install.lock"' EXIT
market_name() { printf 'kimchi-work-%s' "${1//./-}"; }
remove_version() {
  local cli=$1 version=$2 market selector output
  valid_version "$version" || fail 'Invalid installed-version receipt.'
  market=$(market_name "$version");selector="kimchi-work@$market"
  if [[ "$cli" == claude ]]; then
    if output=$(claude plugin uninstall "$selector" --scope user 2>&1); then printf '%s\n' "$output"; else
      case "$output" in *"Plugin \"$selector\" not found in installed plugins"*) ;; *) printf '%s\n' "$output" >&2;return 1 ;; esac
    fi
    if output=$(claude plugin marketplace remove "$market" 2>&1); then printf '%s\n' "$output"; else
      case "$output" in *"Marketplace '$market' not found"*) ;; *) printf '%s\n' "$output" >&2;return 1 ;; esac
    fi
  else
    codex plugin remove "$selector" --json
    if output=$(codex plugin marketplace remove "$market" --json 2>&1); then printf '%s\n' "$output"; else
      case "$output" in *"marketplace \`$market\` is not configured or installed"*) ;; *) printf '%s\n' "$output" >&2;return 1 ;; esac
    fi
  fi
}

if [[ "$action" == uninstall ]]; then
  for cli in "${clients[@]}"; do
    receipt="$prefix/installed/$cli"
    for state in "$receipt.cleanup" "$receipt"; do
      [[ -f "$state" ]] || continue
      remove_version "$cli" "$(cat "$state")"
      rm -- "$state"
    done
  done
  if [[ ! -f "$prefix/installed/claude" && ! -f "$prefix/installed/codex" && -x "$bin_dir/kimchi-adapters" ]]; then "$bin_dir/kimchi-adapters" disable; fi
  printf '%s\n' 'Selected plugins removed. Reporting credentials, ledger and release files are retained.'
  exit 0
fi

for cli in "${clients[@]}"; do "$cli" plugin --help >/dev/null || fail "$cli does not support native plugins. Update the official CLI."; done
script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[[ -f "$script_root/VERSION" && -x "$script_root/bin/kimchi-adapters" ]] || fail 'Kimchi installs and updates the plugins: run the Kimchi installer.'
version=$(cat "$script_root/VERSION")
[[ -z "$requested" || "$requested" == "$version" ]] || fail 'Requested version differs from this package.'
valid_version "$version" || fail 'Invalid package version.'
package=$script_root

target="$prefix/releases/$version"
mkdir -p "$prefix/releases"
if [[ ! -d "$target" ]]; then
  staged=$(mktemp -d "$prefix/releases/.install.XXXXXXXX")
  cp -R "$package/." "$staged/"
  mv -- "$staged" "$target"
fi
market=$(market_name "$version")
for cli in "${clients[@]}"; do
  mkdir -p "$target/plugins/$cli/bin"
  if [[ ! -e "$target/plugins/$cli/bin/kimchi-adapters" ]]; then
    ln "$target/bin/kimchi-adapters" "$target/plugins/$cli/bin/kimchi-adapters"
  fi
  receipt="$prefix/installed/$cli"
  old=
  if [[ -f "$receipt" ]]; then old=$(cat "$receipt");valid_version "$old" || fail 'Invalid installed-version receipt.';fi
  if [[ "$old" == "$version" ]]; then
    printf '%s already at %s\n' "$cli" "$version"
  else
    # Finish an interrupted cleanup before accepting a third installed version.
    if [[ -f "$receipt.cleanup" ]]; then remove_version "$cli" "$(cat "$receipt.cleanup")";rm -- "$receipt.cleanup";fi
    if [[ "$cli" == claude ]]; then
      claude plugin marketplace add "$target" --scope user
      claude plugin install "kimchi-work@$market" --scope user
    else
      codex plugin marketplace add "$target" --json
      codex plugin add "kimchi-work@$market" --json
    fi
    if [[ -n "$old" ]]; then printf '%s\n' "$old" > "$receipt.cleanup.new";mv -- "$receipt.cleanup.new" "$receipt.cleanup";fi
    printf '%s\n' "$version" > "$receipt.new"
    mv -- "$receipt.new" "$receipt"
  fi
  if [[ -f "$receipt.cleanup" ]]; then
    remove_version "$cli" "$(cat "$receipt.cleanup")"
    rm -- "$receipt.cleanup"
  fi
done
ln -s "$target/bin/kimchi-adapters" "$bin_dir/.kimchi-adapters.new.$$"
mv -f -- "$bin_dir/.kimchi-adapters.new.$$" "$bin_dir/kimchi-adapters"
# Keep the bootstrap, rather than a package-bound script, for kimchi-adapters uninstall.
cp "$target/bootstrap.sh" "$prefix/install.sh"
chmod 700 "$prefix/install.sh"
"$bin_dir/kimchi-adapters" activate
printf '%s\n' "Installed $client $version. Start a new client session and accept its plugin trust prompt." 'Reports with your Kimchi sign-in; sign in by running kimchi.' "Control: $bin_dir/kimchi-adapters status" 'Existing inference and enterprise telemetry settings are unchanged.'
