import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Recorder } from "./capture.ts";
import { Flush, FlushOTLP } from "./delivery.ts";
import { PruneEvidence } from "./git.ts";
import { Open } from "./ledger.ts";
import { CheckSignal, WithDeadline, lockSync } from "./platform.ts";
import { Load, Root, StateDir, type Config } from "./settings.ts";

function PruneAccounts(stateRoot: string, now: Date, signal?: AbortSignal) {
  const root = join(stateRoot, "accounts");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  const errors: unknown[] = [];
  for (const entry of entries) {
    CheckSignal(signal);
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      if (!lstatSync(join(dir, "ledger.sqlite")).isFile()) continue;
    } catch {
      continue;
    }
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
  let entries;
  try {
    entries = readdirSync(join(stateRoot, "accounts"), { withFileTypes: true });
  } catch (e: any) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  const errors: unknown[] = [];
  for (const entry of entries) {
    CheckSignal(signal);
    const dir = join(stateRoot, "accounts", entry.name);
    if (!entry.isDirectory() || dir === activeDir) continue;
    try {
      if (!lstatSync(join(dir, "ledger.sqlite")).isFile()) continue;
    } catch {
      continue;
    }
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
export async function Run(c: Config, signal?: AbortSignal): Promise<void> {
  signal = WithDeadline(8000, signal);
  CheckSignal(signal);
  const latest = Load();
  if (latest.disabled || StateDir(latest) !== StateDir(c)) return;
  c = latest;
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
          await PruneAccounts(Root(), new Date(), signal);
          s.DB.query(
            "INSERT INTO meta(key,value) VALUES('pruned-at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(now);
        } catch {
          s.Diagnostic("retention_failed");
        }
      }
      for (const source of ["claude-code", "codex"]) {
        CheckSignal(signal);
        try {
          await new Recorder(s, source, device).RecoverContext(signal);
        } catch {
          s.Diagnostic("recovery_failed");
        }
      }
      try {
        await recoverInactiveAccounts(Root(), s.Dir, signal);
      } catch {
        s.Diagnostic("inactive_account_recovery_failed");
      }
      CheckSignal(signal);
      try {
        await new Recorder(s, "collector", device).ReconcileGit(signal);
      } catch {
        s.Diagnostic("git_reconciliation_incomplete");
      }
      for (let i = 0; i < 10 && !signal?.aborted; i++) {
        CheckSignal(signal);
        try {
          if (!(await Flush(s, c, signal))) break;
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
