import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { kimchiReportingEnabled, type SignIn } from "../kimchi.ts";
import { checkSignal, lockSync, withDeadline } from "../platform.ts";
import { loadConfig, stateDir, stateRoot, verifySignIn } from "../settings.ts";
import { Recorder } from "./capture.ts";
import { flush, flushOtlp } from "./delivery.ts";
import { pruneTraces } from "./commits.ts";
import { pruneEvidence } from "./git.ts";
import { Store } from "./ledger.ts";

function accountLedgers(): string[] {
  const root = join(stateRoot(), "accounts");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => {
      try {
        return lstatSync(join(dir, "ledger.sqlite")).isFile();
      } catch {
        return false;
      }
    });
}

function pruneAccounts(now: Date, signal?: AbortSignal) {
  const errors: unknown[] = [];
  for (const dir of accountLedgers()) {
    checkSignal(signal);
    let store;
    try {
      store = new Store(dir);
      pruneEvidence(new Recorder(store, "collector", ""), now);
    } catch (e) {
      errors.push(e);
    } finally {
      store?.close();
    }
  }
  if (errors.length) throw new AggregateError(errors, "raw expiry incomplete");
}

function recoverInactiveAccounts(activeDir: string, signal?: AbortSignal) {
  const errors: unknown[] = [];
  for (const dir of accountLedgers()) {
    checkSignal(signal);
    if (dir === activeDir) continue;
    let store;
    try {
      store = new Store(dir);
    } catch (e) {
      errors.push(e);
      continue;
    }
    try {
      const device = store.deviceId();
      for (const source of ["claude-code", "codex"]) {
        try {
          new Recorder(store, source, device).recoverContext(signal);
        } catch (e) {
          store.diagnostic("recovery_failed");
          errors.push(e);
        }
      }
      try {
        new Recorder(store, "collector", device).reconcileGit(signal);
      } catch (e) {
        store.diagnostic("git_reconciliation_incomplete");
        errors.push(e);
      }
    } finally {
      store.close();
    }
  }
  if (errors.length) throw new AggregateError(errors, "inactive account recovery incomplete");
}

// One pass: the native lifecycle hook/timer schedules the next attempt.
export async function sync(k: SignIn, signal?: AbortSignal): Promise<void> {
  signal = withDeadline(8000, signal);
  checkSignal(signal);
  let c = loadConfig();
  // Agent shells keep writing Git traces while reporting is off; idle ones are dropped regardless.
  try {
    pruneTraces();
  } catch {
    /* Retried on the next pass. */
  }
  // While Kimchi's PR reporting is off, nothing is verified or uploaded; records stay local.
  if (c.disabled || !kimchiReportingEnabled(c.organizationId)) return;
  try {
    c = await verifySignIn(k, signal);
  } catch {
    // Upload reports the unverified sign-in as delivery_pending; local recovery continues.
  }
  const guard = lockSync(stateDir(c));
  if (!guard) return;
  try {
    const s = new Store(stateDir(c));
    try {
      const device = s.deviceId();
      const row = s.db
        .query("SELECT CAST(value AS INTEGER) AS value FROM meta WHERE key='pruned-at'")
        .get() as { value: number } | null;
      const now = Math.floor(Date.now() / 1000);
      if (now - (row?.value ?? 0) >= 3600) {
        try {
          pruneAccounts(new Date(), signal);
          s.setMeta("pruned-at", String(now));
        } catch {
          s.diagnostic("retention_failed");
        }
      }
      for (const source of ["claude-code", "codex"]) {
        checkSignal(signal);
        try {
          new Recorder(s, source, device).recoverContext(signal);
        } catch {
          s.diagnostic("recovery_failed");
        }
      }
      try {
        recoverInactiveAccounts(s.dir, signal);
      } catch {
        s.diagnostic("inactive_account_recovery_failed");
      }
      checkSignal(signal);
      try {
        new Recorder(s, "collector", device).reconcileGit(signal);
      } catch {
        s.diagnostic("git_reconciliation_incomplete");
      }
      for (let i = 0; i < 10 && !signal?.aborted; i++) {
        checkSignal(signal);
        try {
          if (!(await flush(s, c, k, signal))) break;
        } catch {
          s.diagnostic("delivery_pending");
          break;
        }
      }
      if (!signal?.aborted) {
        checkSignal(signal);
        try {
          await flushOtlp(s, c, signal);
        } catch {
          s.diagnostic("otlp_delivery_pending");
        }
      }
      checkSignal(signal);
    } finally {
      s.close();
    }
  } finally {
    guard.close();
  }
}
