import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildAssets } from "../scripts/gen-assets.ts";
import { clients, files, marketName, marketplaceManifest, plugin, stub } from "../src/packaging.ts";

const root = join(import.meta.dir, "..");
const manifestPath = (client: string) =>
  client === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json";

test("the stub dispatches runtime first, then the standalone binary, then a tty-only hint", () => {
  const runtime = stub.indexOf('if [ -x "$prefix/runtime" ]');
  const binary = stub.indexOf('elif [ -x "$prefix/bin/kimchi-bridge" ]');
  const hint = stub.indexOf("[ ! -t 2 ]");
  expect(runtime).toBeGreaterThan(0);
  expect(binary).toBeGreaterThan(runtime);
  expect(hint).toBeGreaterThan(binary);
  expect(stub).toContain("BUN_BE_BUN");
  expect(stub).toContain("--no-env-file --config=/dev/null");
  expect(stub.endsWith("exit 0\n")).toBe(true);
  // The harness exec line is confined to the runtime branch.
  expect(stub.slice(binary)).not.toContain("current.mjs");
  // One hint text, shared by both installers, in all three stub copies.
  expect(stub.match(/run the kimchi-bridge installer/g)!.length).toBe(1);
});

test("the generated assets agree with the packager's names, manifests and payload bytes", () => {
  const assets = buildAssets(root);
  for (const client of clients) {
    expect(assets.files[`markets/${client}`]).toBe(marketName(root, client) + "\n");
    expect(assets.files[manifestPath(client)]).toBe(marketplaceManifest(root, client));
    expect(JSON.parse(assets.files[manifestPath(client)]).name).toBe(marketName(root, client));
    for (const path of files(join(root, "plugins", plugin, client))) {
      const rel = relative(root, path);
      expect(assets.files[rel]).toBe(readFileSync(path, "utf8"));
    }
  }
  for (const bin of [
    "bin/kimchi-bridge",
    `plugins/${plugin}/claude/bin/kimchi-bridge`,
    `plugins/${plugin}/codex/bin/kimchi-bridge`,
  ])
    expect(assets.files[bin]).toBe(stub);
  expect(assets.files["install.sh"]).toBe(readFileSync(join(root, "install.sh"), "utf8"));
  expect(assets.files["bootstrap.sh"]).toBe(assets.files["install.sh"]);
  expect(assets.files["standalone"]).toBeDefined();
  expect(assets.files["VERSION"]).toBeUndefined();
  expect(assets.files["lib/kimchi-bridge.mjs"]).toBeUndefined();
});

test("the assets carry explicit modes on every path and only safe relatives", () => {
  const assets = buildAssets(root);
  expect(Object.keys(assets.files).sort()).toEqual(Object.keys(assets.modes).sort());
  for (const path of [
    "bin/kimchi-bridge",
    `plugins/${plugin}/claude/bin/kimchi-bridge`,
    `plugins/${plugin}/codex/bin/kimchi-bridge`,
    "install.sh",
    "bootstrap.sh",
  ])
    expect(assets.modes[path]).toBe(0o700);
  for (const path of Object.keys(assets.files)) {
    expect(path.startsWith("/")).toBe(false);
    expect(path.split("/")).not.toContain("..");
  }
});

test("wiring names follow the wiring: the same inputs, the same name; any change, a new name", () => {
  expect(marketName(root, "claude")).toBe(marketName(root, "claude"));
  expect(marketName(root, "claude")).not.toBe(marketName(root, "codex"));
  const copy = mkdtempSync(join(tmpdir(), "kimchi-bridge-wiring-"));
  try {
    for (const path of files(join(root, "plugins", plugin))) {
      const target = join(copy, relative(root, path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path));
    }
    expect(marketName(copy, "claude")).toBe(marketName(root, "claude"));
    const hooks = join(copy, "plugins", plugin, "claude", "hooks", "hooks.json");
    writeFileSync(hooks, JSON.stringify({ hooks: {} }));
    expect(marketName(copy, "claude")).not.toBe(marketName(root, "claude"));
    expect(marketName(copy, "codex")).toBe(marketName(root, "codex"));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
