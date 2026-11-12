import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  clients,
  dataMode,
  executableMode,
  files,
  marketName,
  marketplaceManifest,
  plugin,
  stub,
  type Client,
} from "../src/packaging.ts";

/** The standalone package payload: package-relative paths to contents and modes. */
export interface Assets {
  files: Record<string, string>;
  modes: Record<string, number>;
}

const manifestPath = (client: Client) =>
  client === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json";

/**
 * Everything `kimchi-bridge install` extracts on a standalone machine — the plugin payload
 * byte-identical to the repository's, the stub in the three command locations, the generated
 * receipts and manifests exactly as package.ts computes them, the installer with its execute
 * bits, and the marker that switches install.sh to its standalone branch. No VERSION here: the
 * extractor writes it from the build's own version.
 */
export function buildAssets(root: string): Assets {
  const assets: Assets = { files: {}, modes: {} };
  const put = (path: string, content: string, mode: number) => {
    if (path in assets.files) throw new Error(`duplicate asset ${path}`);
    assets.files[path] = content;
    assets.modes[path] = mode;
  };
  for (const client of clients) {
    for (const path of files(join(root, "plugins", plugin, client)))
      put(relative(root, path), readFileSync(path, "utf8"), dataMode);
    put(`markets/${client}`, marketName(root, client) + "\n", dataMode);
    put(manifestPath(client), marketplaceManifest(root, client), dataMode);
  }
  for (const path of [
    "bin/kimchi-bridge",
    `plugins/${plugin}/claude/bin/kimchi-bridge`,
    `plugins/${plugin}/codex/bin/kimchi-bridge`,
  ])
    put(path, stub, executableMode);
  const installSh = readFileSync(join(root, "install.sh"), "utf8");
  put("install.sh", installSh, executableMode);
  put("bootstrap.sh", installSh, executableMode);
  put("standalone", "1\n", dataMode);
  return assets;
}

export function assetsPath(root: string): string {
  return join(root, ".generated", "install-assets.json");
}

/** Write the payload src/install.ts imports; every bundle and binary build needs it first. */
export function writeAssets(root: string): void {
  mkdirSync(dirname(assetsPath(root)), { recursive: true });
  writeFileSync(assetsPath(root), JSON.stringify(buildAssets(root)) + "\n");
}

if (import.meta.main) writeAssets(join(import.meta.dir, ".."));
