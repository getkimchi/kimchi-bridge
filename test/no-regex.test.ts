import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";

// The moved Kimchi ledger and reconcile library is byte-identical moved code with frozen
// behavior, proven by its own moved tests and (in Kimchi chunk K1) equivalence against the
// pre-move build. Rewriting its parsers to drop regex literals would change behavior, so the
// no-regex policy for bridge-native code does not reach into it. The exemption is an explicit
// allowlist of moved files (from .kimchi/docs/b1-move-map.tsv and b2-move-map.tsv), not a
// whole-directory carve-out: any new bridge-native file — host ports, the pass entry, the
// barrel, vendored extractions, tests — must not use regex literals.
const MOVED: readonly string[] = [
  "src/ledger/import.ts",
  "src/ledger/index.ts",
  "src/ledger/links.ts",
  "src/ledger/memory-records.ts",
  "src/ledger/merge.ts",
  "src/ledger/outbox.ts",
  "src/ledger/protocol.ts",
  "src/ledger/records.ts",
  "src/ledger/row-log.ts",
  "src/ledger/schema.ts",
  "src/ledger/store.ts",
  "src/ledger/work-id.ts",
  "src/ledger/work-record.ts",
  "src/reconcile/pr-cost-reporting/events.ts",
  "src/reconcile/pr-cost-reporting/machine.ts",
  "src/reconcile/pr-cost-reporting/native.ts",
  "src/reconcile/pr-cost-reporting/prelude.ts",
  "src/reconcile/pr-cost-reporting/queue.ts",
  "src/reconcile/pr-cost-reporting/snapshot.ts",
  "src/reconcile/pr-cost-reporting/worker.ts",
  "src/reconcile/pull-request-status/provider-api.ts",
  "src/reconcile/pull-request-status/provider-records.ts",
  "src/reconcile/pull-request-status/pull-requests.ts",
  "src/reconcile/shared/http.ts",
  "src/reconcile/shared/issue-keys.ts",
  "src/reconcile/shared/prelude-stretch.ts",
  "src/reconcile/shared/stat-poller.ts",
  "src/reconcile/shared/url.ts",
  "src/reconcile/work-attribution/billing-api.ts",
  "src/reconcile/work-attribution/billing-evidence.ts",
  "src/reconcile/work-attribution/billing-source.ts",
  "src/reconcile/work-attribution/cost-details.ts",
  "src/reconcile/work-attribution/cost-sync.ts",
  "src/reconcile/work-attribution/costs.ts",
  "src/reconcile/work-attribution/diagnostics.ts",
  "src/reconcile/work-attribution/file-hunks.ts",
  "src/reconcile/work-attribution/file-transitions.ts",
  "src/reconcile/work-attribution/links.ts",
  "src/reconcile/work-attribution/request-tags.ts",
  "src/reconcile/work-attribution/resource.ts",
  "src/reconcile/work-attribution/scope.ts",
  "src/reconcile/work-attribution/summary.ts",
];

/** Recursive directory entries arrive with the platform's separator; normalize to "/". */
function normalized(name: string): string {
  return name.split(sep).join("/");
}

test("runtime and build scripts use native APIs and parsers without local regexes", () => {
  const found: string[] = [];
  const moved = new Set(MOVED);
  for (const dir of ["src", "scripts"])
    for (const file of readdirSync(join(import.meta.dir, "..", dir), {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!file.endsWith(".ts")) continue;
      if (dir === "src" && moved.has(`src/${normalized(file)}`)) continue;
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

// Guards the allowlist itself: these are the bridge-native reconcile files; if one of them
// moves into the allowlist by mistake, the no-regex policy silently stops covering it.
test("the bridge-native reconcile files are never on the moved allowlist", () => {
  const native = [
    "src/reconcile/host.ts",
    "src/reconcile/host-ports.ts",
    "src/reconcile/pass.ts",
    "src/reconcile/index.ts",
    "src/reconcile/work-attribution.ts",
    "src/reconcile/shared/verify-api-key.ts",
    "src/reconcile/shared/platform-url.ts",
    "src/reconcile/shared/durable-write.ts",
    "src/reconcile/shared/git-token.ts",
  ];
  for (const file of native) expect(MOVED).not.toContain(file);
});
