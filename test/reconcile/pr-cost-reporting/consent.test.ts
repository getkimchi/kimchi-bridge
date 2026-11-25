import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { HostPorts } from "../../../src/reconcile/host.js";
import { setDefaultHostPorts } from "../../../src/reconcile/host-ports.js";
import {
  readReportingState,
  readReportingStateFresh,
  setReportingEnabled,
  takeReportingNotice,
  type FreshReportingState,
} from "../../../src/reconcile/pr-cost-reporting/queue.js";
import { backendFor, closeBackends } from "../../../src/ledger/records.js";
import { acquireWriterEpoch, openStore } from "../../../src/ledger/store.js";

/**
 * The reportingConsent host port: when the host owns the PR-reporting choice, "on"/"off" is the
 * enabled value outright, "follow-telemetry" defers to telemetryConsent, and a host without the
 * port (an older embedding release) keeps the legacy state.json semantics exactly. The port is
 * read live at every consent site, so a mid-session change is honored by the next read; the
 * state.json enabled/followsTelemetry fields the port's answer still writes are a mirror for
 * old readers, repaired by the next pass that rewrites the file.
 */

/** "absent" means the host object has no reportingConsent member at all (an old release). */
let choice: "on" | "off" | "follow-telemetry" | undefined | "absent";
let telemetry: boolean;
let directory: string;

function installHost(): void {
  const ports: HostPorts = {
    agentDir: directory,
    e2eSeam: () => undefined,
    now: () => Date.now(),
    credentials: () => ({ token: "", apiUrl: "https://account.example" }),
    gitToken: () => undefined,
    endpoints: () => ({
      llmEndpoint: "https://llm.example",
      openAiBaseUrl: "https://llm.example/openai/v1",
      anthropicBaseUrl: "https://llm.example/anthropic",
      experimentalOpenAiBaseUrl: "https://llm.example/experimental/openai/v1",
      platformApiUrl: "https://account.example",
    }),
    orgPolicy: () => ({ resourceEnabled: () => true }),
    telemetryConsent: () => telemetry,
    ...(choice === "absent"
      ? {}
      : { reportingConsent: () => choice as "on" | "off" | "follow-telemetry" | undefined }),
    metric: () => {},
    fetch: () => Promise.reject(new Error("the consent suite never reaches the network")),
  };
  setDefaultHostPorts(ports);
}

async function writeState(state: Record<string, unknown>): Promise<void> {
  mkdirSync(join(directory, "pr-cost-reporting"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "pr-cost-reporting/state.json"),
    JSON.stringify({ version: 1, entries: {}, ...state }),
  );
}

const producerId = "55555555-5555-4555-8555-555555555555";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kimchi-reporting-consent-"));
  choice = "absent";
  telemetry = true;
});

afterEach(async () => {
  setDefaultHostPorts(undefined);
  closeBackends();
  await rm(directory, { recursive: true, force: true });
});

describe("the reportingConsent host port", () => {
  it('port "off" wins over state.json enabled:true', async () => {
    await writeState({ enabled: true, producerId });
    choice = "off";
    installHost();
    expect((await readReportingState(directory)).enabled).toBe(false);
  });

  it('port "on" wins over state.json enabled:false', async () => {
    await writeState({ enabled: false, producerId });
    choice = "on";
    installHost();
    expect((await readReportingState(directory)).enabled).toBe(true);
  });

  it('"follow-telemetry" follows telemetryConsent', async () => {
    await writeState({ enabled: true, producerId });
    choice = "follow-telemetry";
    telemetry = false;
    installHost();
    expect((await readReportingState(directory)).enabled).toBe(false);
    telemetry = true;
    expect((await readReportingState(directory)).enabled).toBe(true);
  });

  it("a host without the port keeps the legacy state.json semantics", async () => {
    choice = "absent";
    installHost();
    // An explicit opt-out survives a read.
    await writeState({ enabled: false, producerId });
    expect((await readReportingState(directory)).enabled).toBe(false);
    // A follow-telemetry queue re-clamps to telemetry consent on load, as before.
    telemetry = false;
    await writeState({ enabled: true, followsTelemetry: true, producerId });
    expect((await readReportingState(directory)).enabled).toBe(false);
    telemetry = true;
    await writeState({ enabled: true, followsTelemetry: true, producerId });
    expect((await readReportingState(directory)).enabled).toBe(true);
  });

  it("an undefined port answer falls back to the legacy state.json values", async () => {
    await writeState({ enabled: false, producerId });
    choice = undefined;
    installHost();
    expect((await readReportingState(directory)).enabled).toBe(false);
  });

  it("the port is read live, not cached across reads", async () => {
    choice = "on";
    installHost();
    expect((await readReportingState(directory)).enabled).toBe(true);
    choice = "off";
    expect((await readReportingState(directory)).enabled).toBe(false);
  });

  it("the cached-state refresh consults the port on a cache hit", async () => {
    await writeState({ enabled: true, producerId });
    choice = "on";
    installHost();
    const cached: FreshReportingState = {};
    const first = await readReportingStateFresh(directory, cached);
    expect(first.state.enabled).toBe(true);
    // Same file signature: the cache hit itself must re-derive the port's answer.
    choice = "off";
    const second = await readReportingStateFresh(directory, cached);
    expect(second.state.enabled).toBe(false);
  });

  it("state.json's enabled mirror converges to the port's answer after a pass", async () => {
    await writeState({ enabled: true, producerId });
    choice = "off";
    installHost();
    // Any queue update repairs the mirror: the pass rewrites state.json from the
    // port-derived state even when nothing else changed.
    await takeReportingNotice(directory);
    const onDisk = JSON.parse(
      await readFile(join(directory, "pr-cost-reporting/state.json"), "utf8"),
    );
    expect(onDisk.enabled).toBe(false);
    expect(onDisk.followsTelemetry).toBeUndefined();
  });

  it("a session-side queue update survives an epoch bump", async () => {
    choice = "absent";
    installHost();
    await setReportingEnabled(directory, false);
    const backend = backendFor(directory);
    const readEpoch = backend.writerEpoch?.bind(backend);
    let reads = 0;
    backend.writerEpoch = () => {
      reads++;
      if (reads === 1) {
        const other = openStore(directory);
        try {
          acquireWriterEpoch(other);
        } finally {
          other.close();
        }
      }
      return readEpoch?.() ?? 0;
    };
    await setReportingEnabled(directory, true);
    expect(reads).toBe(1);
    expect((await readReportingState(directory)).enabled).toBe(true);
  });

  it("a session-side queue update survives an unreadable ledger", async () => {
    choice = "absent";
    installHost();
    await writeState({ enabled: true, followsTelemetry: true, producerId });
    await writeFile(join(directory, "pr-cost-reporting", "ledger.db"), "not a sqlite database");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await takeReportingNotice(directory)).toBe(true);
      expect(warning).toHaveBeenCalled();
      expect((await readReportingState(directory)).enabled).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  it("a fresh queue's defaults follow the port", async () => {
    choice = "off";
    installHost();
    const state = await readReportingState(directory);
    expect(state.enabled).toBe(false);
    expect(state.followsTelemetry).toBeUndefined();
    choice = "follow-telemetry";
    telemetry = false;
    const next = await readReportingState(directory);
    expect(next.enabled).toBe(false);
    expect(next.followsTelemetry).toBe(true);
  });
});
