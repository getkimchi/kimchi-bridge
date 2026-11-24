import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { open, rename, rm } from "node:fs/promises";

/**
 * Crash-safe replacement, extracted verbatim from Kimchi's config/json.ts (writeFileDurably):
 * syncs a private temporary file, lets the caller confirm it still owns the write, then
 * renames it over `path`. The reporting queue (state.json, state.version) writes through it.
 */
export async function writeFileDurably(
  path: string,
  data: string,
  beforeRename = () => {},
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    beforeRename();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
