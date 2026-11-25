import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";

// The moved Kimchi ledger files listed below keep Kimchi's original parser code, which uses
// regex literals as part of its frozen, hash-covered wire formats and record scanning. Rewriting
// them to drop the regexes would change behavior, so the no-regex policy for bridge-native code
// exempts exactly these files. Everything else under src/ — including src/reconcile — is
// bridge-native and must keep using native APIs and parsers only. Additions to this list need a
// stronger reason than convenience.
const MOVED_WITH_REGEXES = new Set([
  "ledger/import.ts",
  "ledger/protocol.ts",
  "ledger/row-log.ts",
  "ledger/store.ts",
  "ledger/work-id.ts",
  "ledger/work-record.ts",
]);

/** Recursive directory entries arrive with the platform's separator; normalize to "/". */
function normalized(name: string): string {
  return name.split(sep).join("/");
}

test("runtime and build scripts use native APIs and parsers without local regexes", () => {
  const found: string[] = [];
  for (const dir of ["src", "scripts"])
    for (const file of readdirSync(join(import.meta.dir, "..", dir), {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!file.endsWith(".ts")) continue;
      if (dir === "src" && MOVED_WITH_REGEXES.has(normalized(file))) continue;
      const path = join(dir, file),
        source = ts.createSourceFile(
          path,
          readFileSync(join(import.meta.dir, "..", path), "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
      const visit = (node: ts.Node) => {
        if (
          ts.isRegularExpressionLiteral(node) ||
          ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
            node.expression.getText(source) === "RegExp")
        )
          found.push(
            `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
          );
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  expect(found).toEqual([]);
});
