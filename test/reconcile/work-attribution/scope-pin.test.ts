import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import type { HostPorts } from "../../../src/reconcile/host.js";
import { setDefaultHostPorts } from "../../../src/reconcile/host-ports.js";
import { readWorkScope } from "../../../src/reconcile/work-attribution/scope.js";
import { closeBackends } from "../../../src/ledger/records.js";

const WORK = "00000000-0000-4000-8000-000000000001";

it("a repointed agentDir does not change the legacy scope tree mid-session", () => {
  const root = mkdtempSync(join(tmpdir(), "kimchi-scope-pin-"));
  const original = join(root, "original");
  const replacement = join(root, "replacement");
  const link = join(root, "agent-link");
  mkdirSync(join(original, "work", WORK), { recursive: true });
  mkdirSync(replacement, { recursive: true });
  symlinkSync(original, link);
  const scope = {
    version: 1,
    workId: WORK,
    account: {
      apiUrl: "https://account.example",
      organizationId: "30000000-0000-4000-8000-000000000003",
      userId: "40000000-0000-4000-8000-000000000004",
    },
    repository: "/repo/.git",
  };
  writeFileSync(join(original, "work", WORK, "scope.json"), JSON.stringify(scope));
  const ports: HostPorts = {
    agentDir: link,
    e2eSeam: () => undefined,
    now: Date.now,
    credentials: () => ({ token: "", apiUrl: "https://account.example" }),
    gitToken: () => undefined,
    endpoints: () => ({
      llmEndpoint: "https://llm.example",
      openAiBaseUrl: "https://openai.example",
      anthropicBaseUrl: "https://anthropic.example",
      experimentalOpenAiBaseUrl: "https://experimental.example",
      platformApiUrl: "https://account.example",
    }),
    orgPolicy: () => ({ resourceEnabled: () => true }),
    telemetryConsent: () => false,
    metric: () => {},
    fetch: () => Promise.reject(new Error("scope pinning never reaches the network")),
  };
  setDefaultHostPorts(ports);
  try {
    expect(readWorkScope(WORK)).toEqual({ account: scope.account, repository: scope.repository });
    unlinkSync(link);
    symlinkSync(replacement, link);
    expect(readWorkScope(WORK)).toEqual({ account: scope.account, repository: scope.repository });
  } finally {
    setDefaultHostPorts(undefined);
    closeBackends();
    rmSync(root, { recursive: true, force: true });
  }
});
