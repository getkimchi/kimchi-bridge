import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import manifest from "../package.json" with { type: "json" };

const root = join(import.meta.dir, "..");

/** Every module a file reaches through its imports, itself included. */
function reachable(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const source = ts.createSourceFile(entry, readFileSync(entry, "utf8"), ts.ScriptTarget.Latest);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require") &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  seen.set(entry, imports);
  for (const specifier of imports)
    if (specifier.startsWith(".")) reachable(join(dirname(entry), specifier), seen);
  return seen;
}

// Kimchi compiles these modules into its own binary and loads them in its Node-based unit tests and
// on Windows. They may use Node's standard modules and each other, and nothing that needs Bun, this
// machine's Kimchi settings or the bridge's own state directory.
test("the modules the package shares run without Bun or the bridge's state", () => {
  const entries = Object.values(manifest.exports);
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const modules = reachable(join(root, entry));
    const outside = [...modules].flatMap(([file, imports]) =>
      imports
        .filter((specifier) => !specifier.startsWith("node:") && !specifier.startsWith("."))
        .map((specifier) => `${relative(root, file)} imports ${specifier}`),
    );
    expect(outside).toEqual([]);
    const files = [...modules.keys()].map((file) => relative(root, file)).sort();
    for (const stateful of ["src/platform.ts", "src/settings.ts", "src/kimchi.ts"])
      expect(files).not.toContain(stateful);
    for (const file of files) expect(file.startsWith("src/work/")).toBe(true);
  }
});
