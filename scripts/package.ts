import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, valid } from "semver";

export function ReleaseVersion(value: string): string {
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

export async function BuildHelper(
  version: string,
  outfile: string,
  target?: "bun-darwin-x64" | "bun-darwin-arm64" | "bun-linux-x64" | "bun-linux-arm64",
) {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/cli.ts")],
    minify: true,
    bytecode: true,
    define: { BUILD_VERSION: JSON.stringify(version) },
    compile: {
      ...(target ? { target } : {}),
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Helper build failed");
}

async function main() {
  if (process.argv[2] === "--helper") {
    await BuildHelper("dev", resolve(process.argv[3] || "bin/kimchi-adapters"));
    return;
  }
  const [version, output] = process.argv.slice(2);
  if (!version || !output) throw new Error("Usage: scripts/package.sh vVERSION OUTPUT_DIRECTORY");
  ReleaseVersion(version);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    out = resolve(output);
  mkdirSync(out, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), "pr-cost-package-"));
  const market = `kimchi-work-${version.split(".").join("-")}`;
  const platforms = (process.env.PLATFORMS || "darwin/arm64 darwin/amd64 linux/amd64 linux/arm64")
    .split(" ")
    .filter(Boolean);
  try {
    for (const platform of platforms) {
      const [os, arch] = platform.split("/");
      if (!["darwin", "linux"].includes(os!) || !["arm64", "amd64"].includes(arch!))
        throw new Error(`Unsupported platform: ${platform}`);
      const stage = join(temp, `${os}_${arch}`);
      for (const path of ["bin", "plugins", ".claude-plugin", ".agents/plugins"])
        mkdirSync(join(stage, path), { recursive: true });
      const target =
        os === "darwin"
          ? arch === "amd64"
            ? "bun-darwin-x64"
            : "bun-darwin-arm64"
          : arch === "amd64"
            ? "bun-linux-x64"
            : "bun-linux-arm64";
      await BuildHelper(version, join(stage, "bin/kimchi-adapters"), target);
      for (const client of ["claude", "codex"]) {
        cpSync(join(root, "plugins", client), join(stage, "plugins", client), { recursive: true });
        const path = join(
          stage,
          "plugins",
          client,
          client === "claude" ? ".claude-plugin" : ".codex-plugin",
          "plugin.json",
        );
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.version = version.slice(1);
        writeFileSync(path, JSON.stringify(manifest) + "\n");
      }
      writeFileSync(
        join(stage, ".claude-plugin/marketplace.json"),
        JSON.stringify({
          name: market,
          owner: { name: "Kimchi" },
          plugins: [
            {
              name: "kimchi-work",
              source: "./plugins/claude",
              version: version.slice(1),
              description: "Quiet work accounting for official Claude Code",
            },
          ],
        }) + "\n",
      );
      writeFileSync(
        join(stage, ".agents/plugins/marketplace.json"),
        JSON.stringify({
          name: market,
          plugins: [
            {
              name: "kimchi-work",
              source: { source: "local", path: "./plugins/codex" },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Productivity",
            },
          ],
        }) + "\n",
      );
      writeFileSync(join(stage, "VERSION"), version + "\n");
      cpSync(join(root, "install.sh"), join(stage, "install.sh"));
      cpSync(join(root, "install.sh"), join(stage, "bootstrap.sh"));
      const name = `kimchi-adapters_${os}_${arch}.tar.gz`;
      const tar = Bun.spawnSync(["tar", "-czf", join(out, name), "-C", stage, "."], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stderr: "inherit",
      });
      if (tar.exitCode) throw new Error("Archive creation failed");
    }
    cpSync(join(root, "install.sh"), join(out, "install.sh"));
    writeFileSync(
      join(out, "SHA256SUMS"),
      platforms
        .map((platform) => {
          const name = `kimchi-adapters_${platform.split("/").join("_")}.tar.gz`;
          return `${createHash("sha256")
            .update(readFileSync(join(out, name)))
            .digest("hex")}  ${name}\n`;
        })
        .join(""),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (import.meta.main) await main();
