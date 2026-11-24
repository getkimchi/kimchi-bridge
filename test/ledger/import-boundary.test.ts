import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

/**
 * The ledger library must load on every platform Kimchi runs on, Windows included. That fails if
 * anything under src/ledger (or src/reconcile/host.ts, which later chunks build on) pulls in the
 * bridge's macOS/Linux-only platform.ts or bun:ffi, or any bare package Kimchi has not pinned.
 * This suite enforces the import boundary statically: every import in those files must be a
 * relative path to another bridge file, a `node:` builtin, or `bun:sqlite`; and the module graph
 * reachable from the public barrel must never reach platform.ts or escape src/ledger|src/reconcile.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOUNDARY_DIRS = [join(ROOT, "src/ledger"), join(ROOT, "src/reconcile")];
const BOUNDARY_FILES = [...files(join(ROOT, "src/ledger")), ...files(join(ROOT, "src/reconcile"))];
const PLATFORM = join(ROOT, "src/platform.ts");
/**
 * The reconcile passes moved byte-identically from Kimchi and carry three library dependencies
 * the ledger never had: proper-lockfile (the reporting queue's own state.json lock — not the
 * supervisor lease, which stays in Kimchi), yaml (glab's config.yml parsing) and diff
 * (file-hunk matching). Nothing else may be imported, and no @earendil-works/* or Kimchi path
 * may appear in either library.
 */
const RECONCILE_ALLOWED_BARE = new Set(["proper-lockfile", "yaml", "diff"]);

/** Windows-safe containment: `file` is inside `dir` (no separator-specific prefix matching). */
function inside(file: string, dir: string): boolean {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function files(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** One module specifier plus the file it came from. */
interface Import {
  specifier: string;
  file: string;
}

/** Strips line and block comments while leaving string literals (where import specifiers live) intact. */
function stripComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      index++;
      while (index < text.length) {
        if (text[index] === "\\") {
          out += text.slice(index, index + 2);
          index += 2;
          continue;
        }
        const literal = text[index++];
        out += literal;
        if (literal === quote) break;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index += 2;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

function importsOf(file: string): Import[] {
  const text = stripComments(readFileSync(file, "utf8"));
  const specifiers = new Set<string>();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      specifiers.add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      specifiers.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers].map((specifier) => ({ specifier, file }));
}

/** Resolves a relative specifier to its .ts file, mapping the `.js` extension bridge sources use. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base.slice(0, -3)}.ts`]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next form
    }
  }
  return undefined;
}

function classify({ specifier, file }: Import): { ok: boolean; reason?: string } {
  if (specifier.startsWith("node:")) return { ok: true };
  if (specifier === "bun:sqlite") return { ok: true };
  if (specifier === "bun:ffi") return { ok: false, reason: "imports bun:ffi" };
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = resolveRelative(file, specifier);
    if (!target) return { ok: false, reason: `unresolved relative import ${specifier}` };
    if (target === PLATFORM)
      return { ok: false, reason: "imports src/platform.ts, which throws on Windows" };
    return { ok: true };
  }
  if (inside(file, join(ROOT, "src/reconcile")) && RECONCILE_ALLOWED_BARE.has(specifier))
    return { ok: true };
  return {
    ok: false,
    reason: `bare import ${specifier} (only node: builtins, bun:sqlite${
      inside(file, join(ROOT, "src/reconcile")) ? ", and the reconcile libraries" : ""
    } are allowed)`,
  };
}

describe("ledger import boundary", () => {
  it("covers the moved files and only them", () => {
    // Guards the test itself: if the ledger tree is renamed, this suite must follow it.
    expect(BOUNDARY_FILES.length).toBeGreaterThan(10);
    expect(BOUNDARY_FILES).toContain(join(ROOT, "src/ledger/index.ts"));
  });

  it("every import in src/ledger and src/reconcile is relative, node:, bun:sqlite, or an allowed reconcile library", () => {
    const violations: string[] = [];
    for (const file of BOUNDARY_FILES) {
      for (const imp of importsOf(file)) {
        const { ok, reason } = classify(imp);
        if (!ok) violations.push(`${relative(ROOT, imp.file)}: ${reason}`);
      }
    }
    expect(violations.join("\n")).toBe("");
  });

  it("the module graph reachable from the public barrel never reaches platform.ts or leaves the library", () => {
    const seen = new Set<string>();
    const queue = [join(ROOT, "src/ledger/index.ts")];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(file === PLATFORM, `${relative(ROOT, file)} reaches src/platform.ts`).toBe(false);
      // Containment must use native path semantics: a forward-slash prefix check would reject
      // every file on Windows, where separators are backslashes.
      const insideBoundary = BOUNDARY_DIRS.some((dir) => {
        const under = relative(dir, file);
        return (
          under !== "" && !isAbsolute(under) && !under.startsWith(`..${sep}`) && under !== ".."
        );
      });
      expect(insideBoundary, `${relative(ROOT, file)} escapes src/ledger|src/reconcile`).toBe(true);
      for (const { specifier } of importsOf(file)) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          const target = resolveRelative(file, specifier);
          expect(target, `broken relative import ${specifier}`).toBeDefined();
          if (target) queue.push(target);
        }
      }
    }
    // Sanity: the walk really started from the barrel and reached the library's leaves.
    expect(seen.has(join(ROOT, "src/ledger/store.ts"))).toBe(true);
    expect(seen.has(join(ROOT, "src/ledger/memory-records.ts"))).toBe(true);
  });

  it("the reconcile barrel's graph also stays inside the libraries and off platform.ts", () => {
    const seen = new Set<string>();
    const queue = [join(ROOT, "src/reconcile/index.ts")];
    while (queue.length) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(file === PLATFORM, `${relative(ROOT, file)} reaches src/platform.ts`).toBe(false);
      const insideBoundary = BOUNDARY_DIRS.some((dir) => file === dir || inside(file, dir));
      expect(insideBoundary, `${relative(ROOT, file)} escapes src/ledger|src/reconcile`).toBe(true);
      for (const { specifier } of importsOf(file)) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          const target = resolveRelative(file, specifier);
          expect(target, `broken relative import ${specifier}`).toBeDefined();
          if (target) queue.push(target);
        }
      }
    }
    // Sanity: the walk reached the passes the plan moved in chunk B2.
    expect(seen.has(join(ROOT, "src/reconcile/pr-cost-reporting/worker.ts"))).toBe(true);
    expect(seen.has(join(ROOT, "src/reconcile/work-attribution/file-transitions.ts"))).toBe(true);
    expect(seen.has(join(ROOT, "src/reconcile/pull-request-status/pull-requests.ts"))).toBe(true);
  });

  it("no ledger or reconcile file imports Kimchi paths or the @earendil-works SDK", () => {
    const violations: string[] = [];
    for (const file of BOUNDARY_FILES) {
      for (const imp of importsOf(file)) {
        if (imp.specifier.startsWith("@earendil-works/"))
          violations.push(`${relative(ROOT, imp.file)}: ${imp.specifier}`);
        else if (imp.specifier.startsWith("./") || imp.specifier.startsWith("../")) {
          const target = resolveRelative(file, imp.specifier);
          if (target && !BOUNDARY_DIRS.some((dir) => target === dir || inside(target, dir)))
            violations.push(`${relative(ROOT, imp.file)}: ${imp.specifier} escapes the libraries`);
        }
      }
    }
    expect(violations.join("\n")).toBe("");
  });
});
