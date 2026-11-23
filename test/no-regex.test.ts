import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// The moved Kimchi ledger library (src/ledger, src/reconcile) is byte-identical moved code with
// frozen behavior, proven by its own moved tests and (in Kimchi chunk K1) equivalence against the
// pre-move build. Rewriting its parsers to drop regex literals would change behavior, so the
// no-regex policy for bridge-native code does not reach into it.
const MOVED = ["ledger", "reconcile"];

test("runtime and build scripts use native APIs and parsers without local regexes", () => {
  const found: string[] = [];
  for (const dir of ["src", "scripts"])
    for (const file of readdirSync(join(import.meta.dir, "..", dir), {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!file.endsWith(".ts")) continue;
      if (dir === "src" && MOVED.some((m) => file === m || file.startsWith(`${m}/`))) continue;
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
