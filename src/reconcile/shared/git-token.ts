import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Git host tokens (gitTokens.<host> in the global Kimchi config), extracted verbatim from
 * Kimchi's config.ts readGitToken. PR discovery reads the same file the interactive login
 * writes; there is no project-trust or session state involved, so a direct read cannot
 * diverge from the embedding process's answer for the same path.
 */
const KIMCHI_CONFIG_PATH = resolve(homedir(), ".config", "kimchi", "config.json");

export function readGitToken(host: string, configPath?: string): string | undefined {
  const path = configPath ?? KIMCHI_CONFIG_PATH;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const tokens = parsed.gitTokens;
    if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
      const token = (tokens as Record<string, unknown>)[host];
      if (typeof token === "string" && token.length > 0) {
        return token;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
