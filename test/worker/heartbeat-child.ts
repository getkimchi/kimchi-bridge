/**
 * A child process for the heartbeat fence's clock-calibration regressions (see
 * heartbeat.test.ts). Its stdin is a pipe the test drives: the parent writes real heartbeat
 * lines on the wire while the child samples the transport's fence, so every age the child
 * reports covers a real arrival read by the real helper thread — the same shape as the
 * parent process driving the worker over stdio.
 *
 * Modes (argv[2]):
 *  - "slow-construction": the transport's Worker construction is delayed (the test-only
 *    hook in the constructor, via KIMCHI_WORKER_TEST_CONSTRUCT_DELAY_MS) past the fence
 *    window while the parent keeps heartbeating. The child samples the fence every 100 ms
 *    and reports each sample's age and refusal.
 *  - "slow-helper": the HELPER THREAD's actual first action is delayed (the test-only hook in
 *    its source, via KIMCHI_WORKER_TEST_HELPER_START_DELAY_MS) past the handshake bound and
 *    the fence window while the parent keeps heartbeating; the queued heartbeats are read
 *    once it starts. The child samples the fence exactly as in slow-construction.
 *  - "late-heartbeat": the parent heartbeats while the child converges the offset, the
 *    child then blocks its own event loop past the window while the parent delivers one
 *    more heartbeat whose note can only drain after the block. The child reports that
 *    heartbeat's age once the note has drained.
 *  - "first-late": no heartbeat precedes the child's 500 ms block; the parent delivers
 *    exactly one heartbeat 50 ms into the block, so its note — and the startup note — can
 *    only drain after the block, hundreds of ms after the heartbeat's true arrival. The
 *    child reports that first heartbeat's age once its note has drained: the FIRST note
 *    must not calibrate the offset to itself, or its delivery latency is erased from the
 *    age and a stale parent's write passes the fence.
 *  - "sample-gap": the transport's constructor (the top-level one above) inserts a 500 ms
 *    deschedule (the test-only hook in the constructor, via KIMCHI_WORKER_TEST_HANDSHAKE_GAP_MS)
 *    in the gap between the helper thread's construction and the handshake observation. The
 *    helper has already started there: it publishes its startup clock and reads the parent's
 *    first heartbeat early in the gap, so the queued note can only drain once the constructor
 *    returns, hundreds of ms after its true arrival. The child reports that heartbeat's age
 *    once the constructor has returned: a handshake observation whose window does not cover
 *    that whole gap would accept an offset inflated by it and authenticate the stale
 *    heartbeat as fresh (the round-5 probe reported 31.8 ms with refused:false on this exact
 *    shape).
 *
 * The summary goes to stderr as one JSON line; stdout carries only the transport's own
 * request lines (none in these scenarios).
 */
import { LeaseHeartbeatLost, StdioTransport } from "../../src/worker/host-client.js";

const mode = process.argv[2] ?? "";
const windowMs = Number(process.env.HEARTBEAT_WINDOW_MS ?? 100);

function report(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

const transport = new StdioTransport(() => {});

async function sampleFence(rounds: number): Promise<{ ageMs: number; refused: boolean }[]> {
  const samples: { ageMs: number; refused: boolean }[] = [];
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    let refused = false;
    try {
      transport.assertHeartbeatFresh(windowMs);
    } catch (error) {
      refused = error instanceof LeaseHeartbeatLost;
    }
    samples.push({ ageMs: transport.heartbeatAgeMs(), refused });
  }
  return samples;
}

if (mode === "slow-construction" || mode === "slow-helper") {
  const samples = await sampleFence(Number(process.env.HEARTBEAT_SAMPLES ?? 14));
  transport.close();
  report({ mode, samples });
} else if (mode === "first-late") {
  // No converge phase: the very first heartbeat is the late one. The block starts before
  // any note can drain, so the startup note and the heartbeat's note both queue behind it.
  report({ mode, phase: "block" });
  const start = Date.now();
  while (Date.now() - start < 500) {
    /* A real block: neither note can drain until it ends. */
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  const ageMs = transport.heartbeatAgeMs();
  transport.close();
  report({ mode, phase: "summary", ageMs, refused });
} else if (mode === "sample-gap") {
  // The handshake-gap shape: the 500 ms block lived INSIDE the top-level transport's
  // constructor above, between the helper's construction and the handshake observation — the
  // helper was already running and read the parent's single heartbeat early in it, so its
  // note could only drain once the constructor returned. The constructor has returned by
  // now; the fence is sampled immediately after one event-loop turn so the queued note has
  // drained.
  await new Promise((resolve) => setTimeout(resolve, 30));
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  const ageMs = transport.heartbeatAgeMs();
  transport.close();
  report({ mode, phase: "summary", ageMs, refused });
} else if (mode === "late-heartbeat") {
  // Converge: the parent heartbeats every 100 ms while the offset's running minimum settles.
  report({ mode, phase: "converge" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Block: the main thread cannot drain anything while it spins, so the one heartbeat the
  // parent delivers during the block has its note queued behind it.
  report({ mode, phase: "block" });
  const start = Date.now();
  while (Date.now() - start < 500) {
    /* A real block: the heartbeat's note cannot drain until it ends. */
  }
  // The block ends; the queued note drains on the next tick.
  await new Promise((resolve) => setTimeout(resolve, 30));
  let refused = false;
  try {
    transport.assertHeartbeatFresh(windowMs);
  } catch (error) {
    refused = error instanceof LeaseHeartbeatLost;
  }
  const ageMs = transport.heartbeatAgeMs();
  transport.close();
  report({ mode, phase: "summary", ageMs, refused });
}
process.exit(0);
