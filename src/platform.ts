import {
  constants,
  existsSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type * as BunFFI from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { Database } from "bun:sqlite";

/**
 * The command that re-invokes this CLI. The release shim runs
 * `runtime current.mjs ...`, and bun runs an entry script, so argv[1] is a
 * script path; a compiled binary re-invokes itself with only arguments.
 */
export function cliEntry(): string[] {
  const entry = process.argv[1];
  const isScript =
    entry &&
    (entry.endsWith(".mjs") || entry.endsWith(".ts") || entry.endsWith(".js")) &&
    existsSync(entry);
  return isScript ? [process.execPath, entry] : [process.execPath];
}

const darwin = process.platform === "darwin";
if (!darwin && process.platform !== "linux") throw new Error("Only macOS and Linux are supported");
// Darwin fcntl.h and Linux asm-generic/fcntl.h; Node omits O_CLOEXEC.
const cloexec = darwin ? 0x01000000 : 0x80000;
function loadNative() {
  const { dlopen, ptr, read }: typeof BunFFI = require("bun:ffi");
  const library = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
    flock: { args: ["i32", "i32"], returns: "i32" },
    [darwin ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
  });
  return { library, ptr, read };
}
let nativeRuntime: ReturnType<typeof loadNative> | undefined;
function native() {
  return (nativeRuntime ??= loadNative());
}

const deadlines = new WeakMap<AbortSignal, number>();
export function withDeadline(ms: number, parent?: AbortSignal): AbortSignal {
  if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid time budget");
  const deadline = Math.min(
    Date.now() + ms,
    parent ? (deadlines.get(parent) ?? Infinity) : Infinity,
  );
  const timer = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - Date.now())));
  const signal = parent ? AbortSignal.any([parent, timer]) : timer;
  deadlines.set(signal, deadline);
  return signal;
}
export function checkSignal(signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (signal && Date.now() >= (deadlines.get(signal) ?? Infinity))
    throw new DOMException("operation timed out", "TimeoutError");
}
export function remainingTime(signal: AbortSignal | undefined, maximum: number): number {
  checkSignal(signal);
  return Math.min(
    maximum,
    signal ? Math.max(1, (deadlines.get(signal) ?? Infinity) - Date.now()) : maximum,
  );
}

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function nativeError(operation: string, path: string): NodeJS.ErrnoException {
  const { library, read } = native();
  const address = library.symbols[darwin ? "__error" : "__errno_location"]!();
  // The dynamic errno symbol shares a table with int-returning libc functions.
  const errno = read.i32(address as Pointer);
  const code = Object.entries(osConstants.errno).find(([, n]) => n === errno)?.[0] ?? "EIO";
  return Object.assign(new Error(`${operation}: ${code}: ${path}`), {
    code,
    errno,
    path,
    syscall: operation,
  });
}

function openat(dir: number, path: string, flags: number): number {
  const { library, ptr } = native();
  const name = Buffer.from(`${path}\0`);
  const fd = library.symbols.openat!(dir, ptr(name), flags | cloexec, 0);
  if (fd < 0) throw nativeError("openat", path);
  return fd;
}

function directory(path: string): number {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Absolute directory required");
  // Pin the explicit native root directly, like Go OpenRoot; sandbox policy
  // permits this root but deliberately denies opening its private ancestors.
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function rootedOpen(root: number, path: string): number {
  const parts = path.split(sep);
  let parent = root;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = openat(
        parent,
        part,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (parent !== root) closeSync(parent);
      parent = next;
    }
    return openat(
      parent,
      parts.at(-1)!,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    if (parent !== root) closeSync(parent);
  }
}

/** Every component is opened relative to a pinned directory, never through a symlink. */
export function safeRead(
  root: string,
  path: string,
  maxBytes = 4 << 20,
): { bytes: Buffer; stat: Stats } {
  const rel = relative(resolve(root), isAbsolute(path) ? resolve(path) : resolve(root, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes("\0")) {
    throw new Error("File escapes its root");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid file size limit");
  const rootfd = directory(root);
  let fd = -1;
  try {
    fd = rootedOpen(rootfd, rel);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new Error("Not a bounded regular file");
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Number(before.size) + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const check = rootedOpen(rootfd, rel);
    let named: ReturnType<typeof fstatSync>;
    try {
      named = fstatSync(check, { bigint: true });
    } finally {
      closeSync(check);
    }
    if (
      length > maxBytes ||
      BigInt(length) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.size !== after.size ||
      named.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("File changed during capture");
    }
    return { bytes: buffer.subarray(0, length), stat: fstatSync(fd) };
  } finally {
    if (fd >= 0) closeSync(fd);
    closeSync(rootfd);
  }
}

/** The same kernel lock as rc.5; closing the descriptor releases it after crashes too. */
export function lockSync(dir: string): { close(): void } | null {
  const { library } = native();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(
    join(dir, "worker.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error("Invalid sync lock file");
  }
  if (library.symbols.flock!(fd, 2 | 4) !== 0) {
    const error = nativeError("flock", dir);
    closeSync(fd);
    if (error.errno === osConstants.errno.EWOULDBLOCK || error.errno === osConstants.errno.EAGAIN)
      return null;
    throw error;
  }
  let closed = false;
  return {
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}

export function openDatabase(path: string): Database {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  // Create the file private first; SQLite would create it with the process umask.
  const fd = openSync(path, "a", 0o600);
  closeSync(fd);
  const db = new Database(path, { create: true, strict: true });
  db.exec(
    "PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
  );
  return db;
}
