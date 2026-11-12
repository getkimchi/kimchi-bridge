import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The plugin each client's marketplace lists, from plugins/<plugin>/<client>.
export const plugin = "kimchi-work";
export const clients = ["claude", "codex"] as const;
export type Client = (typeof clients)[number];

// Files the extraction restores with the execute bit; everything else is 0600 data.
export const executableMode = 0o700,
  dataMode = 0o600;

// Every plugin's bin/kimchi-bridge, and the user's command when the release links it. Runs the
// code on Kimchi's runtime when present — Kimchi's updates stay authoritative — without loading
// the project's .env or bunfig.toml. Without Kimchi's runtime, the standalone binary takes
// over, never as Bun: BUN_BE_BUN would turn it into the bun command. With neither, the hook exits
// silently: Codex shows every hook's output in the session,
// so the hint (one text, shared by both installers) goes to a terminal only.
export const stub = `#!/bin/sh
prefix=\${KIMCHI_BRIDGE_PREFIX:-$HOME/.local/share/kimchi-bridge}
if [ -x "$prefix/runtime" ]; then
exec env BUN_BE_BUN=1 "$prefix/runtime" --no-env-file --config=/dev/null "$prefix/current.mjs" "$@"
elif [ -x "$prefix/bin/kimchi-bridge" ]; then
unset BUN_BE_BUN
exec "$prefix/bin/kimchi-bridge" "$@"
else
[ ! -t 2 ] || echo 'kimchi-bridge: run the kimchi-bridge installer.' >&2
fi
exit 0
`;

/** Recursive sorted file list, the packager's wiring inventory. */
export function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Clients key hook trust by marketplace, so each client's marketplace changes only when its own
 * plugin wiring does: a release that changes only code needs no new registration or review. The
 * hash covers the stub plus the client's plugin files, package-relative.
 */
export function marketName(root: string, client: Client): string {
  const wiring = createHash("sha256").update(stub);
  for (const path of files(join(root, "plugins", plugin, client)))
    wiring.update(relative(root, path)).update("\0").update(readFileSync(path));
  return `kimchi-bridge-${wiring.digest("hex").slice(0, 12)}`;
}

/** The client's marketplace manifest, naming the wiring-hashed marketplace. */
export function marketplaceManifest(root: string, client: Client): string {
  const name = marketName(root, client);
  if (client === "claude")
    return (
      JSON.stringify({
        name,
        owner: { name: "Kimchi" },
        plugins: [
          {
            name: plugin,
            source: `./plugins/${plugin}/claude`,
            description: "Quiet work accounting for official Claude Code",
          },
        ],
      }) + "\n"
    );
  return (
    JSON.stringify({
      name,
      plugins: [
        {
          name: plugin,
          source: { source: "local", path: `./plugins/${plugin}/codex` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }) + "\n"
  );
}
