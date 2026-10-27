import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SignIn } from "../kimchi.ts";
import { CheckSignal, WithDeadline, lockSync } from "../platform.ts";
import { Load, Root, StateDir, Verify } from "../settings.ts";
import { Recorder } from "./capture.ts";
import { Flush, FlushOTLP } from "./delivery.ts";
import { PruneEvidence } from "./git.ts";
import { Open } from "./ledger.ts";

function accountLedgers(stateRoot: string): string[] {
  const root = join(stateRoot, "accounts");
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

function PruneAccounts(stateRoot: string, now: Date, signal?: AbortSignal) {
  const errors: unknown[] = [];
  for (const dir of accountLedgers(stateRoot)) {
    CheckSignal(signal);
    let store;
    try {
      store = Open(dir);
      PruneEvidence(new Recorder(store, "collector", ""), now);
    } catch (e) {
      errors.push(e);
    } finally {
      store?.Close();
    }
  }
  if (errors.length) throw new AggregateError(errors, "raw expiry incomplete");
}

function recoverInactiveAccounts(stateRoot: string, activeDir: string, signal?: AbortSignal) {
  const errors: unknown[] = [];
  for (const dir of accountLedgers(stateRoot)) {
    CheckSignal(signal);
    if (dir === activeDir) continue;
    let store;
    try {
      store = Open(dir);
    } catch (e) {
      errors.push(e);
      continue;
    }
    try {
      const device = store.DeviceID();
      for (const source of ["claude-code", "codex"]) {
        try {
          new Recorder(store, source, device).RecoverContext(signal);
        } catch (e) {
          store.Diagnostic("recovery_failed");
          errors.push(e);
        }
      }
      try {
        new Recorder(store, "collector", device).ReconcileGit(signal);
      } catch (e) {
        store.Diagnostic("git_reconciliation_incomplete");
        errors.push(e);
      }
    } finally {
      store.Close();
    }
  }
  if (errors.length) throw new AggregateError(errors, "inactive account recovery incomplete");
}

// One pass: the native lifecycle hook/timer schedules the next attempt.
export async function Run(k: SignIn, signal?: AbortSignal): Promise<void> {
  signal = WithDeadline(8000, signal);
  CheckSignal(signal);
  let c = Load();
  if (c.disabled) return;
  try {
    c = await Verify(k, signal);
  } catch {
    // Upload reports the unverified sign-in as delivery_pending; local recovery continues.
  }
  const guard = lockSync(StateDir(c));
  if (!guard) return;
  try {
    const s = Open(StateDir(c));
    try {
      const device = s.DeviceID();
      const row = s.DB.query(
        "SELECT CAST(value AS INTEGER) AS value FROM meta WHERE key='pruned-at'",
      ).get() as { value: number } | null;
      const now = Math.floor(Date.now() / 1000);
      if (now - (row?.value ?? 0) >= 3600) {
        try {
          PruneAccounts(Root(), new Date(), signal);
          s.SetMeta("pruned-at", String(now));
        } catch {
          s.Diagnostic("retention_failed");
        }
      }
      for (const source of ["claude-code", "codex"]) {
        CheckSignal(signal);
        try {
          new Recorder(s, source, device).RecoverContext(signal);
        } catch {
          s.Diagnostic("recovery_failed");
        }
      }
      try {
        recoverInactiveAccounts(Root(), s.Dir, signal);
      } catch {
        s.Diagnostic("inactive_account_recovery_failed");
      }
      CheckSignal(signal);
      try {
        new Recorder(s, "collector", device).ReconcileGit(signal);
      } catch {
        s.Diagnostic("git_reconciliation_incomplete");
      }
      for (let i = 0; i < 10 && !signal?.aborted; i++) {
        CheckSignal(signal);
        try {
          if (!(await Flush(s, c, k, signal))) break;
        } catch {
          s.Diagnostic("delivery_pending");
          break;
        }
      }
      if (!signal?.aborted) {
        CheckSignal(signal);
        try {
          await FlushOTLP(s, c, signal);
        } catch {
          s.Diagnostic("otlp_delivery_pending");
        }
      }
      CheckSignal(signal);
    } finally {
      s.Close();
    }
  } finally {
    guard.close();
  }
}
