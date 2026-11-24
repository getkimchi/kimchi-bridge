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
 *  - "late-heartbeat": the parent heartbeats while the child converges the offset, the
 *    child then blocks its own event loop past the window while the parent delivers one
 *    more heartbeat whose note can only drain after the block. The child reports that
 *    heartbeat's age once the note has drained.
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

if (mode === "slow-construction") {
  const samples: { ageMs: number; refused: boolean }[] = [];
  const rounds = Number(process.env.HEARTBEAT_SAMPLES ?? 14);
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
  transport.close();
  report({ mode, samples });
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
