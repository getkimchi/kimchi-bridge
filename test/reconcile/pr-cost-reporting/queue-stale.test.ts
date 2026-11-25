import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "bun:test";
import { setDefaultHostPorts } from "../../../src/reconcile/host-ports.js";
import {
  readReportingState,
  setReportingEnabled,
  takeReportingNotice,
} from "../../../src/reconcile/pr-cost-reporting/queue.js";
import { closeBackends } from "../../../src/ledger/records.js";
import { acquireWriterEpoch, openStore } from "../../../src/ledger/store.js";
import type { HostPorts } from "../../../src/reconcile/host.js";

/**
 * A stale queue writer cannot rename its older state over a successor's. The window a file
 * rename cannot fence atomically is narrowed on both sides of it: the writer epoch observed
 * when the queue lock was acquired is re-read immediately before every durable rename (under
 * the queue lock, together with the ledger fence and the caller's own assertion), so a process
 * suspended across its lease loss aborts on resume instead of publishing. The proof uses a real
 * child process paused by SIGSTOP between its sidecar rename and the state rename, a successor
 * that takes the lease and publishes through the now-stale queue lock, and the child's resumed
 * write.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CHILD = join(ROOT, "test/reconcile/pr-cost-reporting/stale-session-child.ts");
const CONSENT_CHILD = join(ROOT, "test/reconcile/pr-cost-reporting/stale-consent-child.ts");

const dirs: string[] = [];
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-queue-stale-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  setDefaultHostPorts(undefined);
  closeBackends();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function host(agentDir: string): HostPorts {
  return {
    agentDir,
    e2eSeam: () => undefined,
    now: () => Date.now(),
    credentials: () => ({ token: "key", apiUrl: "https://account.example" }),
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
    fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
  };
}

it("a suspended session-side queue writer aborts instead of renaming over a successor's state", async () => {
  const dir = agentDir();
  setDefaultHostPorts(host(dir));
  // The successor's state: reporting explicitly opted out.
  await setReportingEnabled(dir, false);
  // The lease the child's update runs under when it acquires the queue lock.
  const holder = openStore(dir);
  const epoch = acquireWriterEpoch(holder);
  const child = spawn("bun", [CHILD, dir], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || !JSON.parse(first.value).beforeStateRename)
    throw new Error(`no pause marker: ${first.value}`);
  // Suspend the writer inside its check-to-rename window, and outlast proper-lockfile's 5 s
  // stale window so the successor steals the queue lock.
  process.kill(child.pid!, "SIGSTOP");
  let resumed = false;
  try {
    await new Promise((resolve) => setTimeout(resolve, 6_200));
    // A successor takes the lease and publishes its own queue state through the stale lock.
    const next = acquireWriterEpoch(holder);
    expect(next).toBe(epoch + 1);
    await setReportingEnabled(dir, false);
    expect(
      JSON.parse(readFileSync(join(dir, "pr-cost-reporting/state.json"), "utf8")).enabled,
    ).toBe(false);
    process.kill(child.pid!, "SIGCONT");
    resumed = true;
    const second = await messages.next();
    const exit = await exited;
    const message = second.done ? undefined : JSON.parse(second.value);
    // The resumed writer aborted its own publication — its update rejected (the fence check,
    // or the stale lock's release after the successor stole it) — and the successor's opt-out
    // survived on disk.
    expect(exit).toBe(0);
    expect(message?.done).toBe(true);
    expect(typeof message?.threw).toBe("string");
    const final = JSON.parse(readFileSync(join(dir, "pr-cost-reporting/state.json"), "utf8"));
    expect(final.enabled).toBe(false);
  } finally {
    holder.close();
    if (!resumed && child.exitCode === null) {
      try {
        process.kill(child.pid!, "SIGCONT");
      } catch {}
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {}
    }
    await exited;
  }
}, 30_000);

/** The host for the consent regression: the PR-reporting choice is a file the test owns, so a
 *  second actor can flip it while the first pass is suspended. */
function consentHost(agentDir: string, consentFile: string): HostPorts {
  return {
    agentDir,
    e2eSeam: () => undefined,
    now: () => Date.now(),
    credentials: () => ({ token: "key", apiUrl: "https://account.example" }),
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
    reportingConsent: () => {
      const text = readFileSync(consentFile, "utf8").trim();
      return text === "" ? undefined : (text as "on" | "off" | "follow-telemetry");
    },
    metric: () => {},
    fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
  };
}

it("a consent change made while a pass is suspended survives its stale state rename", async () => {
  const dir = agentDir();
  // The port's backing value: the child and the second actor both read it live, so flipping
  // the file is the user changing the choice while the first pass sits in the rename window.
  const consentFile = join(dir, "consent-choice.txt");
  writeFileSync(consentFile, "on");
  setDefaultHostPorts(consentHost(dir, consentFile));
  // Seed the opted-out queue the child's session-side update rewrites: the stale pass
  // re-enabling an explicit opt-out is exactly the race the port must survive.
  await setReportingEnabled(dir, false);
  const holder = openStore(dir);
  const epoch = acquireWriterEpoch(holder);
  const child = spawn("bun", [CONSENT_CHILD, dir, consentFile], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout! });
  const messages = lines[Symbol.asyncIterator]();
  const first = await messages.next();
  if (first.done || !JSON.parse(first.value).beforeStateRename)
    throw new Error(`no pause marker: ${first.value}`);
  // Suspend the writer inside the unfenceable rename window — past its own last check — and
  // outlast proper-lockfile's 5 s stale window so the second actor steals the queue lock.
  process.kill(child.pid!, "SIGSTOP");
  let resumed = false;
  try {
    await new Promise((resolve) => setTimeout(resolve, 6_200));
    // The second actor: the lease moves, the user's choice flips to "off" through the port,
    // and the successor publishes the opt-out through the now-stale queue lock.
    const next = acquireWriterEpoch(holder);
    expect(next).toBe(epoch + 1);
    writeFileSync(consentFile, "off");
    await setReportingEnabled(dir, false);
    expect(
      JSON.parse(readFileSync(join(dir, "pr-cost-reporting/state.json"), "utf8")).enabled,
    ).toBe(false);
    process.kill(child.pid!, "SIGCONT");
    resumed = true;
    const second = await messages.next();
    const exit = await exited;
    const message = second.done ? undefined : JSON.parse(second.value);
    // The child's rename either aborted on its own release path or published its stale
    // mirror — the rename itself is the accepted residual window either way.
    expect(exit).toBe(0);
    expect(message?.done).toBe(true);
    // The consent actually observed after the race: the port owns the choice, so the
    // opt-out survives a state.json whose mirror the stale rename flipped back on.
    const final = await readReportingState(dir);
    expect(final.enabled).toBe(false);
    // The mirror converges on the next pass that rewrites the file.
    await takeReportingNotice(dir);
    expect(
      JSON.parse(readFileSync(join(dir, "pr-cost-reporting/state.json"), "utf8")).enabled,
    ).toBe(false);
  } finally {
    holder.close();
    if (!resumed && child.exitCode === null) {
      try {
        process.kill(child.pid!, "SIGCONT");
      } catch {}
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {}
    }
    await exited;
  }
}, 30_000);
