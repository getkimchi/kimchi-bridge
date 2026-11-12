import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, placeBinary, validVersion } from "./install.ts";
import { readBytes, request } from "./kimchi.ts";

const repository = "getkimchi/kimchi-bridge";
// A compiled binary is tens of megabytes; the bound stops a misbehaving server, not a release.
const binaryLimit = 512 << 20,
  textLimit = 1 << 20,
  binaryTimeout = 10 * 60_000;

export interface UpdateOptions {
  prefix: string;
  /** The running build's version. */
  current: string;
  /** The running compiled binary; undefined when Kimchi's runtime runs the bundle. */
  binary: string | undefined;
  /** A release tag to install instead of the latest release. */
  requested?: string;
  output: (text: string) => void;
  /** GitHub's REST API for the repository and its release downloads; tests serve their own. */
  api?: string;
  downloads?: string;
}

/** This machine's release asset, as the release workflow names it. */
export function assetName(platform: string = process.platform, arch: string = process.arch) {
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64"))
    throw new Error(`kimchi-bridge has no build for ${platform}-${arch}`);
  return `kimchi-bridge-${platform}-${arch}`;
}

/** The sha256 a sha256sum-style checksums file lists for `name`. */
export function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [sum, file] = line.trim().split(" ").filter(Boolean);
    if (sum && (file === name || file === "*" + name)) return sum.toLowerCase();
  }
  return undefined;
}

/** The latest published release's tag, from GitHub's REST API. */
async function latestRelease(api: string, current: string): Promise<string> {
  let tag: unknown;
  try {
    const response = await request(`${api}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `kimchi-bridge/${current}`,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    tag = (
      JSON.parse((await readBytes(response, textLimit)).toString("utf8")) as Record<string, unknown>
    ).tag_name;
  } catch (error) {
    throw new Error(
      `could not find the latest release: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }
  if (typeof tag !== "string" || !validVersion(tag))
    throw new Error("could not find the latest release: GitHub named no valid release tag");
  return tag;
}

// Release downloads redirect to GitHub's asset host; they carry no credentials to leak.
async function download(url: string, limit: number, timeout: number): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    throw new Error(`could not download ${url}: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`could not download ${url}: HTTP ${response.status}`);
  }
  return readBytes(response, limit);
}

/** The clients the plugins were added to, as install's argument. */
function installedClient(prefix: string): string | undefined {
  const claude = existsSync(join(prefix, "installed", "claude")),
    codex = existsSync(join(prefix, "installed", "codex"));
  return claude && codex ? "both" : claude ? "claude" : codex ? "codex" : undefined;
}

/**
 * Update the standalone install to the latest (or the requested) release: download this
 * machine's binary, check it against the release's checksums, then run the new binary's install,
 * which puts it in place and registers the plugins it carries. Nothing changes until the download
 * checks out. Kimchi's bundle leaves updates to Kimchi.
 */
export async function update(options: UpdateOptions): Promise<void> {
  const { prefix, current, requested, output } = options;
  if (!options.binary) {
    output("Kimchi updates kimchi-bridge when it updates itself.\n");
    return;
  }
  if (requested !== undefined && !validVersion(requested))
    throw new Error(`invalid release tag ${requested}: expected vX.Y.Z or vX.Y.Z-rc.N`);
  const asset = assetName();
  const target =
    requested ??
    (await latestRelease(options.api ?? `https://api.github.com/repos/${repository}`, current));
  if (target === current) {
    output(`kimchi-bridge ${current} is up to date.\n`);
    return;
  }
  if (!requested && validVersion(current) && compareVersions(target, current) < 0) {
    output(`kimchi-bridge ${current} is newer than the latest release, ${target}.\n`);
    return;
  }
  output(`Updating kimchi-bridge ${current} to ${target}.\n`);
  const base = `${options.downloads ?? `https://github.com/${repository}/releases/download`}/${target}`;
  const binary = await download(`${base}/${asset}`, binaryLimit, binaryTimeout);
  const sums = await download(`${base}/checksums.txt`, textLimit, 60_000);
  const expected = checksumOf(sums.toString("utf8"), asset);
  if (!expected) throw new Error(`the ${target} release lists no checksum for ${asset}`);
  if (createHash("sha256").update(binary).digest("hex") !== expected)
    throw new Error(
      `${asset} does not match the ${target} release's checksum; nothing was updated`,
    );
  // Run from the install directory, where the binary lands: a temporary directory may forbid
  // running programs.
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(prefix, ".update."));
  try {
    const file = join(dir, "kimchi-bridge");
    writeFileSync(file, binary, { mode: 0o700 });
    const client = installedClient(prefix);
    if (!client) {
      placeBinary(file, join(prefix, "bin", "kimchi-bridge"));
      output(
        `Updated to ${target}. The plugins are not installed: run kimchi-bridge install claude, codex or both.\n`,
      );
      return;
    }
    const proc = Bun.spawn([file, "install", client], {
      env: { ...process.env, KIMCHI_BRIDGE_PREFIX: prefix },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0)
      throw new Error(
        `the update to ${target} did not finish: run kimchi-bridge install ${client}`,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
