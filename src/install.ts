import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import assetsJson from "../.generated/install-assets.json";

declare const BUILD_VERSION: string | undefined;

interface Assets {
  files: Record<string, string>;
  modes: Record<string, number>;
}
const assets = assetsJson as Assets;

// install.sh's valid_version: vMAJOR.MINOR.PATCH with an optional -rc.N suffix.
const digits = (text: string) =>
  text !== "" && [...text].every((char) => char >= "0" && char <= "9");
export function validVersion(value: string): boolean {
  if (!value.startsWith("v")) return false;
  const text = value.slice(1),
    rc = text.indexOf("-rc.");
  if (rc >= 0 && !digits(text.slice(rc + 4))) return false;
  const core = (rc < 0 ? text : text.slice(0, rc)).split(".");
  return core.length === 3 && core.every(digits);
}

/** Orders valid release versions; a release sorts after its release candidates. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => {
    const text = value.slice(1),
      rc = text.indexOf("-rc.");
    return [
      ...(rc < 0 ? text : text.slice(0, rc)).split(".").map(Number),
      rc < 0 ? Number.POSITIVE_INFINITY : Number(text.slice(rc + 4)),
    ];
  };
  const x = parts(a),
    y = parts(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** This build's release version; a build without one cannot name the package it installs. */
export function buildVersion(): string {
  const version = typeof BUILD_VERSION === "string" ? BUILD_VERSION : "";
  if (!validVersion(version))
    throw new Error(
      `this build carries no release version; build it with bun build --compile --define BUILD_VERSION='"vX.Y.Z"'`,
    );
  return version;
}

/**
 * The compiled binary this process runs from; undefined when bun runs a script or Kimchi's
 * bundle. A compiled binary's entry lives in its embedded /$bunfs/ file system.
 */
export function compiledBinary(): string | undefined {
  return Bun.main.startsWith("/$bunfs/") ? process.execPath : undefined;
}

const sameBytes = (a: string, b: string): boolean => {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/**
 * Put `source` at `bin` with one rename, so a running hook sees the old or the new binary and
 * macOS never sees a signed file change in place. Returns false when the bytes already match.
 */
export function placeBinary(source: string, bin: string): boolean {
  if (existsSync(bin) && sameBytes(bin, source)) return false;
  mkdirSync(dirname(bin), { recursive: true, mode: 0o700 });
  const staged = join(dirname(bin), `.${basename(bin)}.new.${process.pid}`);
  try {
    copyFileSync(source, staged);
    chmodSync(staged, 0o700);
    renameSync(staged, bin);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  return true;
}

/** The package Kimchi's release carries, with the standalone marker in place of the bundle. */
function writePackage(dir: string, version: string): void {
  for (const [path, content] of Object.entries(assets.files)) {
    const parts = path.split("/");
    if (path.startsWith("/") || parts.includes("..")) throw new Error(`unsafe asset path ${path}`);
    const file = join(dir, ...parts);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content);
    chmodSync(file, assets.modes[path] ?? 0o600);
  }
  writeFileSync(join(dir, "VERSION"), version + "\n");
  chmodSync(join(dir, "VERSION"), 0o600);
}

/**
 * Install this build without Kimchi. The binary every hook runs goes in place first — as
 * install.sh links Kimchi's code before registering, since a new wiring may call commands only
 * the new code has, and the activation runs the new binary. Then the package's own install.sh
 * copies it into the releases under its lock and registers the plugins: the same receipts,
 * marketplaces and wiring hash as Kimchi's release, so neither re-registers the other's.
 */
export async function installPackage(client: string, prefix: string): Promise<void> {
  const version = buildVersion();
  const self = compiledBinary();
  if (!self) throw new Error("Kimchi installs and updates the plugins: run the Kimchi installer.");
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const pkg = mkdtempSync(join(prefix, ".package."));
  try {
    writePackage(pkg, version);
    placeBinary(self, join(prefix, "bin", "kimchi-bridge"));
    const proc = Bun.spawn(["bash", join(pkg, "install.sh"), "install", client, version], {
      // Without env, Bun passes the environment this process started with, BUN_BE_BUN included.
      env: { ...process.env, KIMCHI_BRIDGE_PREFIX: prefix },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) throw new Error("installer command failed");
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
}
