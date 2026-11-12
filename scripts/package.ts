import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse, valid } from "semver";
import { marketName, marketplaceManifest, plugin, stub, type Client } from "../src/packaging.ts";
import { writeAssets } from "./gen-assets.ts";

export function releaseVersion(value: string): string {
  const text = value.startsWith("v") ? value.slice(1) : "",
    version = parse(text);
  const pre = version?.prerelease ?? [];
  const rc =
    pre.length === 2 &&
    pre[0] === "rc" &&
    typeof pre[1] === "number" &&
    Number.isSafeInteger(pre[1]) &&
    pre[1] >= 0;
  if (!text || valid(text) !== text || !version || version.build.length || (pre.length && !rc))
    throw new Error("Invalid package version");
  return value;
}

export async function buildBundle(version: string, outfile: string) {
  // The bundle carries the standalone installer's payload, generated from this checkout.
  writeAssets(join(import.meta.dir, ".."));
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/cli.ts")],
    target: "bun",
    minify: true,
    define: { BUILD_VERSION: JSON.stringify(version) },
  });
  if (!result.success) throw new AggregateError(result.logs, "Bundle build failed");
  await Bun.write(outfile, result.outputs[0]!);
}

async function main() {
  const [version, output] = process.argv.slice(2);
  if (!version || !output) throw new Error("Usage: scripts/package.sh vVERSION OUTPUT_DIRECTORY");
  releaseVersion(version);
  const root = resolve(import.meta.dir, ".."),
    out = resolve(output),
    stage = mkdtempSync(join(tmpdir(), "kimchi-bridge-package-"));
  // The archive's top folder becomes share/kimchi/bridge in Kimchi's release; mkdtemp makes it 0700.
  chmodSync(stage, 0o755);
  const market = (client: Client) => marketName(root, client);
  try {
    for (const path of ["bin", "lib", "markets", ".claude-plugin", ".agents/plugins"])
      mkdirSync(join(stage, path), { recursive: true });
    await buildBundle(version, join(stage, "lib/kimchi-bridge.mjs"));
    cpSync(join(root, "plugins"), join(stage, "plugins"), { recursive: true });
    for (const bin of ["bin", `plugins/${plugin}/claude/bin`, `plugins/${plugin}/codex/bin`]) {
      mkdirSync(join(stage, bin), { recursive: true });
      writeFileSync(join(stage, bin, "kimchi-bridge"), stub, { mode: 0o755 });
    }
    writeFileSync(
      join(stage, ".claude-plugin/marketplace.json"),
      marketplaceManifest(root, "claude"),
    );
    writeFileSync(
      join(stage, ".agents/plugins/marketplace.json"),
      marketplaceManifest(root, "codex"),
    );
    for (const client of ["claude", "codex"] as const)
      writeFileSync(join(stage, "markets", client), market(client) + "\n");
    writeFileSync(join(stage, "VERSION"), version + "\n");
    cpSync(join(root, "install.sh"), join(stage, "install.sh"));
    cpSync(join(root, "install.sh"), join(stage, "bootstrap.sh"));
    mkdirSync(out, { recursive: true });
    const name = "kimchi-bridge.tar.gz";
    // Without --no-xattrs a macOS build carries com.apple.provenance, which GNU tar warns about.
    const tar = Bun.spawnSync(["tar", "--no-xattrs", "-czf", join(out, name), "-C", stage, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stderr: "inherit",
    });
    if (tar.exitCode) throw new Error("Archive creation failed");
    const sum = createHash("sha256")
      .update(readFileSync(join(out, name)))
      .digest("hex");
    writeFileSync(join(out, "SHA256SUMS"), `${sum}  ${name}\n`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
if (import.meta.main) await main();
