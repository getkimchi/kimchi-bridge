import { join, resolve } from "node:path";
import { writeAssets } from "./gen-assets.ts";
import { releaseVersion } from "./package.ts";

const root = join(import.meta.dir, "..");

/**
 * The standalone binary's build. Hooks run it inside the user's projects, so it never loads a
 * project's .env or bunfig.toml (Kimchi's stub passes --no-env-file --config=/dev/null for the
 * same reason). Without a version the binary refuses to install: tests build one that way.
 */
export function compileCommand(
  version: string | undefined,
  outfile: string,
  target?: string,
): string[] {
  return [
    process.execPath,
    "build",
    "--compile",
    "--minify",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...(target ? [`--target=${target}`] : []),
    ...(version ? ["--define", `BUILD_VERSION=${JSON.stringify(version)}`] : []),
    join(root, "src/cli.ts"),
    "--outfile",
    outfile,
  ];
}

/** Compile a release binary, with the installer payload generated from this checkout. */
export function compile(version: string, outfile: string, target?: string): void {
  releaseVersion(version);
  writeAssets(root);
  const proc = Bun.spawnSync(compileCommand(version, outfile, target), {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error("Compile failed:\n" + proc.stderr.toString());
}

if (import.meta.main) {
  const [version, output, target] = process.argv.slice(2);
  if (!version || !output)
    throw new Error("Usage: bun scripts/compile.ts vVERSION OUTFILE [bun-target]");
  compile(version, resolve(output), target);
}
