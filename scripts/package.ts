import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
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

// Every plugin's bin/kimchi-bridge, and the user's command. Kimchi's runtime runs the code
// the installer made current, without loading the project's .env or bunfig.toml. Without Kimchi
// only a terminal gets the hint: Codex shows every hook's output in the session.
export const SHIM = `#!/bin/sh
prefix=\${KIMCHI_BRIDGE_PREFIX:-$HOME/.local/share/kimchi-bridge}
[ -x "$prefix/runtime" ] || { [ ! -t 2 ] || echo 'kimchi-bridge: run the Kimchi installer.' >&2; exit 0; }
exec env BUN_BE_BUN=1 "$prefix/runtime" --no-env-file --config=/dev/null "$prefix/current.mjs" "$@"
`;

export async function BuildBundle(version: string, outfile: string) {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/cli.ts")],
    target: "bun",
    minify: true,
    define: { BUILD_VERSION: JSON.stringify(version) },
  });
  if (!result.success) throw new AggregateError(result.logs, "Bundle build failed");
  await Bun.write(outfile, result.outputs[0]!);
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function main() {
  const [version, output] = process.argv.slice(2);
  if (!version || !output) throw new Error("Usage: scripts/package.sh vVERSION OUTPUT_DIRECTORY");
  ReleaseVersion(version);
  const root = resolve(import.meta.dir, ".."),
    out = resolve(output),
    stage = mkdtempSync(join(tmpdir(), "kimchi-bridge-package-"));
  // Clients key hook trust by marketplace, so each client's marketplace changes only when its
  // own plugin wiring does: a release that changes only code needs no new registration or review.
  const market = (client: string) => {
    const wiring = createHash("sha256").update(SHIM);
    for (const path of files(join(root, "plugins", client)))
      wiring.update(relative(root, path)).update("\0").update(readFileSync(path));
    return `kimchi-bridge-${wiring.digest("hex").slice(0, 12)}`;
  };
  try {
    for (const path of ["bin", "lib", "markets", ".claude-plugin", ".agents/plugins"])
      mkdirSync(join(stage, path), { recursive: true });
    await BuildBundle(version, join(stage, "lib/kimchi-bridge.mjs"));
    cpSync(join(root, "plugins"), join(stage, "plugins"), { recursive: true });
    for (const bin of ["bin", "plugins/claude/bin", "plugins/codex/bin"]) {
      mkdirSync(join(stage, bin), { recursive: true });
      writeFileSync(join(stage, bin, "kimchi-bridge"), SHIM, { mode: 0o755 });
    }
    writeFileSync(
      join(stage, ".claude-plugin/marketplace.json"),
      JSON.stringify({
        name: market("claude"),
        owner: { name: "Kimchi" },
        plugins: [
          {
            name: "kimchi-work",
            source: "./plugins/claude",
            description: "Quiet work accounting for official Claude Code",
          },
        ],
      }) + "\n",
    );
    writeFileSync(
      join(stage, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: market("codex"),
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
    for (const client of ["claude", "codex"])
      writeFileSync(join(stage, "markets", client), market(client) + "\n");
    writeFileSync(join(stage, "VERSION"), version + "\n");
    cpSync(join(root, "install.sh"), join(stage, "install.sh"));
    cpSync(join(root, "install.sh"), join(stage, "bootstrap.sh"));
    mkdirSync(out, { recursive: true });
    const name = "kimchi-bridge.tar.gz";
    const tar = Bun.spawnSync(["tar", "-czf", join(out, name), "-C", stage, "."], {
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
