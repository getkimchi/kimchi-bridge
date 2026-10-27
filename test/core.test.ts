import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Open, type Store } from "../src/work/ledger";
import {
  CanonicalTime,
  EncodeBatch,
  EncodeEvent,
  Hash,
  Integer,
  NewID,
  NumberText,
  Parse,
  StableID,
  Stringify,
  Validate,
  ValidateBatch,
  type Acknowledgement,
  type Batch,
  type Event,
} from "../src/work/protocol";
import {
  DecodeOTLP,
  Load,
  Root,
  Save,
  SessionStateDir,
  StateDir,
  type Config,
} from "../src/settings";

const inputs = JSON.parse(
  readFileSync(new URL("./fixtures/event-inputs.json", import.meta.url), "utf8"),
) as Event[];
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/go-core-golden.json", import.meta.url), "utf8"),
);
const dirs: string[] = [];
const stores: Store[] = [];
const priorHome = process.env.KIMCHI_BRIDGE_HOME;
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-ts-core-"));
  dirs.push(dir);
  return dir;
}
function store(): Store {
  const s = Open(temp());
  stores.push(s);
  return s;
}
function event(entityId = "entity", count = "1"): Event {
  return {
    entityId,
    source: "codex",
    sourceVersion: "test",
    deviceId: "12345678-1234-1234-1234-123456789abc",
    observeTime: "2026-10-23T12:30:40.123456789Z",
    coverage: { code: "test", count },
  };
}
function ack(b: Batch): Acknowledgement {
  return {
    batchId: b.id,
    receipts: b.events.map((e) => ({ id: e.id!, revision: e.revision!, status: "accepted" })),
  };
}
function account(actor = NewID(), key = "kimchi-key"): Config {
  return {
    apiUrl: "https://api.cast.ai",
    organizationId: "11111111-1111-1111-1111-111111111111",
    actorId: actor,
    credentialHash: createHash("sha256").update(key).digest("hex"),
  };
}
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.Close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.KIMCHI_BRIDGE_HOME;
  else process.env.KIMCHI_BRIDGE_HOME = priorHome;
});

describe("Go wire and identity compatibility", () => {
  test("all eight typed payloads match Go encoding, hashes and validation", () => {
    expect(inputs.length).toBe(8);
    for (const [i, e] of inputs.entries()) {
      expect(EncodeEvent(e)).toBe(golden.events[i].body);
      expect(Hash(e)).toBe(golden.events[i].hash);
      expect(golden.events[i].validation).toBe("");
      expect(() => Validate(e)).not.toThrow();
    }
    expect(StableID(...golden.stableParts)).toBe(golden.stableId);
    expect(CanonicalTime("2026-10-23T12:30:40.123400000+00:00")).toBe("2026-10-23T12:30:40.1234Z");
    expect(CanonicalTime("2026-10-23T12:30:40.123400000+02:30")).toBe(
      "2026-10-23T12:30:40.1234+02:30",
    );
  });
  test("native JSON preserves large IDs, numeric lexemes and UTF8 key order", () => {
    const value = Parse(golden.nativeInput);
    expect(Stringify(value)).toBe(golden.nativeBody);
    expect(Hash(value)).toBe(golden.nativeHash);
    expect(NumberText(value.z)).toBe("9007199254740993");
    expect(Integer(Parse("1000000000000"))).toBe(1_000_000_000_000);
    expect(Integer(Parse("1e3"))).toBeUndefined();
    expect(Integer(Parse("1.0"))).toBeUndefined();
    expect(Integer(Parse("9223372036854775808"))).toBeUndefined();
  });
  test("known zero and unknown counters stay different; malformed evidence rejected", () => {
    const e = structuredClone(inputs[1]!);
    const zero = Hash(e);
    delete e.usage!.raw.cacheReadTokens;
    expect(Hash(e)).not.toBe(zero);
    e.usage!.raw.inputTokens = "1000000000001";
    expect(() => Validate(e)).toThrow("invalid typed event evidence");
    const bad = { ...inputs[0]!, coverage: { code: "also", count: "1" } };
    expect(() => Validate(bad)).toThrow("exactly one");
    expect(() => ValidateBatch({ version: 1, id: "b", events: [inputs[0]!, inputs[0]!] })).toThrow(
      "duplicate",
    );
  });
});

describe("legacy persistence and delivery", () => {
  test("opens Go schema, replays pending batch and continues existing revision hashes", () => {
    const dir = temp(),
      db = new Database(join(dir, "ledger.sqlite"));
    for (const ddl of golden.schema) db.exec(ddl);
    for (const [table, rows] of Object.entries(golden.tables) as [string, any[]][])
      for (const row of rows) {
        const cols = Object.keys(row),
          values = Object.values(row).map((v: any) =>
            v && typeof v === "object" && "blobBase64" in v
              ? Buffer.from(v.blobBase64, "base64")
              : v,
          );
        db.query(
          `INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
        ).run(...(values as any[]));
      }
    db.close();
    const s = Open(dir);
    stores.push(s);
    expect(s.DeviceID()).toBe(event().deviceId);
    expect(s.Events()).toEqual(golden.observations);
    const pending = s.PendingBatch()!;
    expect(EncodeBatch(pending)).toBe(EncodeBatch(golden.pendingBatch));
    s.Acknowledge(pending, ack(pending));
    expect(s.PendingBatch()!.events[0]!.revision).toBe("2");
    s.Observe({ ...event("persisted", "2"), observeTime: "2026-10-24T12:00:00Z" });
    expect(s.Events().length).toBe(2);
    s.Observe(event("persisted", "3"));
    const third = s.Events()[2]!;
    expect(third.revision).toBe("3");
    expect(third.baseRevision).toBe("2");
    expect(third.baseHash).toBe(
      golden.observations[1].baseHash === Hash(golden.observations[0])
        ? Hash(golden.observations[1])
        : "invalid-Go-fixture",
    );
    expect((s.DB.query("PRAGMA user_version").get() as any).user_version).not.toBe(0);
  });
  test("fresh observations produce exactly the Go event IDs and chains", () => {
    const s = store();
    s.Observe(event("persisted", "1"));
    s.Observe(event("persisted", "2"));
    expect(s.Events()).toEqual(golden.observations);
  });
  test("235 observations upload bounded deltas and survive lost ACK restart", () => {
    const dir = temp();
    let s = Open(dir);
    for (let i = 0; i < 235; i++) s.Observe(event("entity-" + i));
    const original = s.PendingBatch()!,
      body = EncodeBatch(original);
    s.Close();
    s = Open(dir);
    stores.push(s);
    expect(EncodeBatch(s.PendingBatch()!)).toBe(body);
    expect(() => s.Acknowledge(original, { batchId: original.id, receipts: [] })).toThrow(
      "incomplete",
    );
    const sizes: number[] = [];
    for (let b = s.PendingBatch(); b; b = s.PendingBatch()) {
      sizes.push(b.events.length);
      expect(Buffer.byteLength(EncodeBatch(b))).toBeLessThan((1 << 20) + 4096);
      s.Acknowledge(b, ack(b));
      s.Acknowledge(b, ack(b));
    }
    expect(sizes).toEqual([100, 100, 35]);
    s.Observe(event("entity-0"));
    expect(s.PendingBatch()).toBeNull();
    s.Observe(event("entity-0", "2"));
    expect(s.PendingBatch()!.events).toHaveLength(1);
    const totals = s.Status(),
      actual = s.DB.query("SELECT SUM(length(body)) AS bytes FROM events").get() as any;
    expect(totals.normalizedBytes).toBe(actual.bytes);
  });
  test("recursive 413 splits preserve event order and byte identity on retries", () => {
    const s = store();
    for (let i = 1; i <= 8; i++) s.Observe(event("same", String(i)));
    const original = s.PendingBatch()!,
      ids = original.events.map((e) => e.id!);
    s.SplitBatch(original);
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const b = s.PendingBatch();
      if (!b) break;
      expect(EncodeBatch(s.PendingBatch()!)).toBe(EncodeBatch(b));
      if (b.events.length > 1) {
        s.SplitBatch(b);
        continue;
      }
      seen.push(b.events[0]!.id!);
      expect(() => s.SplitBatch(b)).toThrow("retained");
      s.Acknowledge(b, ack(b));
    }
    expect(seen).toEqual(ids);
    expect(s.Status().pending).toBe(0);
    const e = s.Events()[0]!;
    s.Put(e);
    expect(() => s.Put({ ...e, coverage: { code: "test", count: "99" } })).toThrow(
      "identity conflicts",
    );
  });
});

describe("durable evidence and account pins", () => {
  test("raw BLOBs deduplicate, enforce shared legacy cap and reject corruption", () => {
    const dir = temp();
    let s = Open(dir);
    const hash = s.PutBlob(Buffer.from("before"));
    s.PutBlob(null);
    s.Close();
    s = Open(dir);
    stores.push(s);
    expect(s.Blob(hash).toString()).toBe("before");
    expect(statSync(join(dir, "ledger.sqlite")).mode & 0o777).toBe(0o600);
    s.DB.query("UPDATE blob_totals SET total_bytes=? WHERE id=1").run(256 << 20);
    expect(s.PutBlob(Buffer.from("before"))).toBe(hash);
    expect(() => s.PutBlob(Buffer.from("new"))).toThrow("capacity");
    s.DB.exec("DELETE FROM blobs; UPDATE blob_totals SET total_bytes=0 WHERE id=1");
    const legacy = join(dir, "blobs");
    mkdirSync(legacy);
    writeFileSync(join(legacy, hash), "before");
    const padding = join(legacy, ".pending-legacy");
    const fd = openSync(padding, "w");
    closeSync(fd);
    truncateSync(padding, (256 << 20) - 6);
    expect(() => s.PutBlob(Buffer.from("new"))).toThrow("capacity");
    expect(s.PutBlob(Buffer.from("before"))).toBe(hash);
    writeFileSync(join(legacy, hash), "changed");
    expect(() => s.Blob(hash)).toThrow("hash mismatch");
    expect(() => s.Blob("../ledger.sqlite")).toThrow("invalid evidence hash");
  });
  test("100 sessions share one registry and preserve old account pins after rotation", () => {
    process.env.KIMCHI_BRIDGE_HOME = temp();
    const c = account();
    const before = StateDir(c),
      pin = SessionStateDir(c, "codex", "old");
    expect(pin).toBe(before);
    const rotated = account(c.actorId, "rotated");
    expect(StateDir(rotated)).toBe(before);
    const next = account();
    expect(StateDir(next)).not.toBe(before);
    expect(SessionStateDir(next, "codex", "old")).toBe(before);
    for (let i = 0; i < 100; i++) SessionStateDir(c, "codex", String(i));
    expect(existsSync(join(Root(), "session-accounts"))).toBe(false);
    mkdirSync(join(Root(), "session-accounts"));
    const old = NewID();
    writeFileSync(
      join(Root(), "session-accounts", StableID("codex", "legacy") + ".json"),
      JSON.stringify(old),
    );
    expect(basename(SessionStateDir(c, "codex", "legacy"))).toBe(old);
    expect(basename(SessionStateDir(c, "claude-code", "legacy"))).toBe(basename(before));
  });
  test("private atomic config saves drop an earlier release's key and runtime and decode only OTLP", () => {
    process.env.KIMCHI_BRIDGE_HOME = temp();
    const c = { ...account(), disabled: true };
    Save({
      ...c,
      apiKey: "earlier-release-key",
      enabled: true,
      runtimeExecutable: "/managed/runtime",
      runtimeRevision: NewID(),
    } as Config);
    expect(Load()).toEqual(c);
    expect(readFileSync(join(Root(), "config.json"), "utf8")).not.toContain("earlier-release-key");
    expect(statSync(join(Root(), "config.json")).mode & 0o777).toBe(0o600);
    const decoded = DecodeOTLP(
      JSON.stringify({ otlpUrl: "https://collector.example/v1/logs", runtimeExecutable: "/x" }),
    );
    expect(decoded).toEqual({
      otlpUrl: "https://collector.example/v1/logs",
      otlpHeaders: undefined,
    });
    expect(() => DecodeOTLP("x".repeat((32 << 10) + 1))).toThrow("too large");
    expect(() => DecodeOTLP(JSON.stringify({ otlpUrl: "http://collector.example" }))).toThrow(
      "HTTPS",
    );
  });
});
