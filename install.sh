#!/usr/bin/env bash
set -euo pipefail

# Native plugin management for the package in Kimchi's release. No inference settings.
umask 077
# The plugin the package registers with each client.
plugin=kimchi-work
prefix=${KIMCHI_BRIDGE_PREFIX:-"$HOME/.local/share/kimchi-bridge"}
bin_dir=${KIMCHI_BRIDGE_BIN_DIR:-"$HOME/.local/bin"}
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
  [[ ! -f "$prefix/installed/code" ]] || printf 'code: %s\n' "$(cat "$prefix/installed/code")"
  [[ ! -x "$bin_dir/kimchi-bridge" ]] || "$bin_dir/kimchi-bridge" status
  exit 0
fi
for cli in "${clients[@]}"; do
  # Uninstalling skips a client the plugins were never added to.
  [[ "$action" == uninstall && ! -f "$prefix/installed/$cli" && ! -f "$prefix/installed/$cli.cleanup" ]] && continue
  command -v "$cli" >/dev/null || fail "Install official $cli first."
done
mkdir -p "$prefix/installed" "$bin_dir"
if [[ "$action" != uninstall && ( -e "$bin_dir/kimchi-bridge" || -L "$bin_dir/kimchi-bridge" ) ]]; then
  existing=$(readlink "$bin_dir/kimchi-bridge") || fail 'Refusing to replace an unmanaged kimchi-bridge binary.'
  case "$existing" in "$prefix/releases/"*/bin/kimchi-bridge) ;; *) fail 'Refusing to replace an unmanaged kimchi-bridge link.' ;; esac
fi
mkdir "$prefix/install.lock" 2>/dev/null || fail "Another installer is running ($prefix/install.lock)."
trap 'rmdir "$prefix/install.lock"' EXIT
# A client's receipt names its registered marketplace, kimchi-bridge-<hash>, which changes only
# with the plugin wiring. Earlier releases registered kimchi-work-<hash> or kimchi-work-<version>,
# and their receipts name that version; cleanup still removes those registrations.
market_of() { if valid_version "$1"; then printf 'kimchi-work-%s' "${1//./-}"; else printf '%s' "$1"; fi; }
valid_market() {
  local name
  case "$1" in kimchi-bridge-*) name=${1#kimchi-bridge-} ;; kimchi-work-*) name=${1#kimchi-work-} ;; *) return 1 ;; esac
  case "$name" in ""|*[!0123456789abcdefghijklmnopqrstuvwxyz-]*) return 1 ;; esac
}
remove_market() {
  local cli=$1 market selector output
  market=$(market_of "$2")
  valid_market "$market" || fail 'Invalid registration receipt.'
  selector="$plugin@$market"
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
      remove_market "$cli" "$(cat "$state")"
      rm -- "$state"
    done
  done
  if [[ ! -f "$prefix/installed/claude" && ! -f "$prefix/installed/codex" && -x "$bin_dir/kimchi-bridge" ]]; then "$bin_dir/kimchi-bridge" disable; fi
  printf '%s\n' 'Selected plugins removed. Reporting credentials, ledger and release files are retained.'
  exit 0
fi

script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[[ -f "$script_root/VERSION" && -f "$script_root/lib/kimchi-bridge.mjs" ]] || fail 'Kimchi installs and updates the plugins: run the Kimchi installer.'
version=$(cat "$script_root/VERSION")
[[ -z "$requested" || "$requested" == "$version" ]] || fail 'Requested version differs from this package.'
valid_version "$version" || fail 'Invalid package version.'
# The plugins run on Kimchi's runtime; Kimchi's installer and updater pass its path.
runtime=${KIMCHI_BIN:-$(command -v kimchi || true)}
[[ "$runtime" == /* && -x "$runtime" ]] || fail 'Kimchi runs the plugins: install Kimchi first.'

target="$prefix/releases/$version"
mkdir -p "$prefix/releases"
if [[ ! -d "$target" ]]; then
  staged=$(mktemp -d "$prefix/releases/.install.XXXXXXXX")
  cp -R "$script_root/." "$staged/"
  mv -- "$staged" "$target"
fi
# Every registered plugin runs this code, so link it before registering. Each link changes with
# one rename: a running hook sees the old or the new target.
ln -s "$runtime" "$prefix/.runtime.$$"
mv -f -- "$prefix/.runtime.$$" "$prefix/runtime"
ln -s "$target/lib/kimchi-bridge.mjs" "$prefix/.current.$$"
mv -f -- "$prefix/.current.$$" "$prefix/current.mjs"
ln -s "$target/bin/kimchi-bridge" "$bin_dir/.kimchi-bridge.new.$$"
mv -f -- "$bin_dir/.kimchi-bridge.new.$$" "$bin_dir/kimchi-bridge"
registered=
for cli in "${clients[@]}"; do
  market=$(cat "$script_root/markets/$cli")
  valid_market "$market" || fail 'Invalid package marketplace.'
  receipt="$prefix/installed/$cli"
  old=
  [[ ! -f "$receipt" ]] || old=$(market_of "$(cat "$receipt")")
  # The same wiring needs no new registration: the plugin already runs the current code.
  if [[ "$old" == "$market" ]]; then
    printf '%s plugin already registered\n' "$cli"
  else
    "$cli" plugin --help >/dev/null || fail "$cli does not support native plugins. Update the official CLI."
    # Finish an interrupted cleanup before accepting a third registration.
    if [[ -f "$receipt.cleanup" ]]; then remove_market "$cli" "$(cat "$receipt.cleanup")";rm -- "$receipt.cleanup";fi
    if [[ "$cli" == claude ]]; then
      claude plugin marketplace add "$target" --scope user
      claude plugin install "$plugin@$market" --scope user
    else
      codex plugin marketplace add "$target" --json
      codex plugin add "$plugin@$market" --json
    fi
    if [[ -n "$old" ]]; then printf '%s\n' "$old" > "$receipt.cleanup.new";mv -- "$receipt.cleanup.new" "$receipt.cleanup";fi
    printf '%s\n' "$market" > "$receipt.new"
    mv -- "$receipt.new" "$receipt"
    registered=1
  fi
  if [[ -f "$receipt.cleanup" ]]; then
    remove_market "$cli" "$(cat "$receipt.cleanup")"
    rm -- "$receipt.cleanup"
  fi
done
# Saving the settings drops what earlier releases kept there (their reporting key), which also
# stops an earlier release's resident daemon.
"$bin_dir/kimchi-bridge" activate
# Written last, and only once every added client has this package's registration, so Kimchi's
# next update retries a client whose registration failed.
current=1
for cli in claude codex; do
  [[ ! -f "$prefix/installed/$cli" ]] || [[ "$(market_of "$(cat "$prefix/installed/$cli")")" == "$(cat "$script_root/markets/$cli")" ]] || current=
done
if [[ -n "$current" ]]; then
  printf '%s\n' "$version" > "$prefix/installed/code.new"
  mv -- "$prefix/installed/code.new" "$prefix/installed/code"
fi
# Keep the bootstrap, rather than a package-bound script, for kimchi-bridge uninstall.
cp "$target/bootstrap.sh" "$prefix/install.sh"
chmod 700 "$prefix/install.sh"
printf '%s\n' "Installed $client $version." 'Reports with your Kimchi sign-in; sign in by running kimchi.' "Control: $bin_dir/kimchi-bridge status" 'Existing inference and enterprise telemetry settings are unchanged.'
[[ -z "$registered" ]] || printf '%s\n' 'Start a new Claude Code or Codex session; Codex asks you to trust the hooks.'
