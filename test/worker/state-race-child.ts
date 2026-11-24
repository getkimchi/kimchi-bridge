/**
 * A child process for the wait-expiry state-race stress test (see
 * state-race.test.ts). The race the fix covers lies between two adjacent
 * instructions on the transport's own thread — the blocking wait expiring and
 * the compare-exchange that ends it — so no outer process can force a reply, a
 * cancel, or parent death to land inside that window deterministically. This
 * child instead runs many iterations of the real blocking request against a
 * racing thread that stores a terminal state at a randomized moment spread
 * over the whole preamble and beyond, and checks the invariant every
 * iteration: when the racing store moved WAITING to CANCELLED, the request
 * reports the cancel, and when it lost the race (the state had already moved
 * on), the request reports the expiry. Misclassifying a won race as a timeout
 * is a violation and fails the child.
 *
 * stdout is /dev/null for the request lines the transport writes; the summary
 * goes to stderr as one JSON line.
 */
import { Worker } from "node:worker_threads";
import { HostRequestError, StdioTransport } from "../../src/worker/host-client.js";

/** The transport's shared slot layout: the state index and two state values. */
const STATE = 0;
const STATE_WAITING = 1;
const STATE_CANCELLED = 4;

/** Iterations of the race; each is a few hundred microseconds of work. */
const ITERATIONS = 20_000;
/**
 * The racer's delay ceiling in nanoseconds: several times the request's whole
 * pre-wait preamble, so randomized delays land before, inside, and after the
 * window between the wait's expiry and the compare-exchange.
 */
const MAX_DELAY_NS = 150_000;

// The handshake between the two threads: [0] go (0 idle, 1 go, 2 stop),
// [1] the racer's compare-exchange return value, [2] the racer has reported.
const gate = new Int32Array(new SharedArrayBuffer(16));

const RACER_SOURCE = `
"use strict";
const { workerData } = require("node:worker_threads");
const gate = new Int32Array(workerData.gate);
const slots = new Int32Array(workerData.slots);
for (;;) {
  Atomics.wait(gate, 0, 0);
  if (Atomics.load(gate, 0) === 2) return;
  // Consume the go token before working: exactly one round per signal, so a
  // still-set token cannot run the racer a second time over a later request.
  Atomics.store(gate, 0, 0);
  // Spin until the main thread's request is WAITING. The bound only matters
  // when the window was missed entirely: the request has already ended, and
  // the compare-exchange below still reports that as a lost race.
  let spins = 0;
  while (Atomics.load(slots, ${STATE}) !== ${STATE_WAITING} && spins++ < 2_000_000) {}
  const until = process.hrtime.bigint() + BigInt(Math.round(Math.random() * ${MAX_DELAY_NS}));
  while (process.hrtime.bigint() < until) {}
  const was = Atomics.compareExchange(slots, ${STATE}, ${STATE_WAITING}, ${STATE_CANCELLED});
  Atomics.store(gate, 1, was);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
}
`;

const transport = new StdioTransport(() => {});
// A deadline already in the past makes every wait expire at once (a zero
// timeout), so each iteration reaches the timed-out branch immediately.
transport.deadlineAt = Date.now() - 1;
const slots = (transport as unknown as { slots: Int32Array }).slots;
const racer = new Worker(RACER_SOURCE, {
  eval: true,
  workerData: { gate: gate.buffer, slots: slots.buffer },
});

let won = 0;
let lost = 0;
const violations: { iteration: number; outcome: string; observed: number }[] = [];
for (let iteration = 0; iteration < ITERATIONS; iteration++) {
  Atomics.store(gate, 1, -1);
  Atomics.store(gate, 2, 0);
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  let outcome: string;
  try {
    transport.request("consent");
    outcome = "returned";
  } catch (error) {
    outcome = error instanceof HostRequestError ? error.cause : `unexpected:${String(error)}`;
  }
  while (Atomics.load(gate, 2) !== 1) Atomics.wait(gate, 2, 0, 1000);
  const observed = Atomics.load(gate, 1);
  if (observed === STATE_WAITING) won++;
  else lost++;
  // The invariant: a terminal state the racer stored before the request's
  // own compare-exchange is honored, never reported as an expiry.
  if (observed === STATE_WAITING && outcome !== "canceled")
    violations.push({ iteration, outcome, observed });
  if (observed !== STATE_WAITING && outcome !== "deadline")
    violations.push({ iteration, outcome, observed });
}
Atomics.store(gate, 0, 2);
Atomics.notify(gate, 0);
racer.terminate();
transport.close();
process.stderr.write(`${JSON.stringify({ iterations: ITERATIONS, won, lost, violations })}\n`);
// The terminated threads may still be winding down; the summary is out.
process.exit(0);
