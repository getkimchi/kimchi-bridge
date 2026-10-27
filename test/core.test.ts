import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
import { Store } from "../src/work/ledger";
import {
  canonicalHash,
  canonicalTime,
  encodeBatch,
  encodeEvent,
  integer,
  numberText,
  parseJson,
  stableId,
  stringifyJson,
  validateBatch,
  validateEvent,
  validHost,
  type Acknowledgement,
  type Batch,
  type Event,
} from "../src/work/protocol";
import {
  decodeOtlp,
  loadConfig,
  saveConfig,
  sessionStateDir,
  stateDir,
  stateRoot,
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
  const s = new Store(temp());
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
function account(actor: string = randomUUID(), key = "kimchi-key"): Config {
  return {
    apiUrl: "https://app.kimchi.dev/api",
    organizationId: "11111111-1111-1111-1111-111111111111",
    actorId: actor,
    credentialHash: createHash("sha256").update(key).digest("hex"),
  };
}
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
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
      expect(encodeEvent(e)).toBe(golden.events[i].body);
      expect(canonicalHash(e)).toBe(golden.events[i].hash);
      expect(golden.events[i].validation).toBe("");
      expect(() => validateEvent(e)).not.toThrow();
    }
    expect(stableId(...golden.stableParts)).toBe(golden.stableId);
    expect(canonicalTime("2026-10-23T12:30:40.123400000+00:00")).toBe("2026-10-23T12:30:40.1234Z");
    expect(canonicalTime("2026-10-23T12:30:40.123400000+02:30")).toBe(
      "2026-10-23T12:30:40.1234+02:30",
    );
  });
  test("native JSON preserves large IDs, numeric lexemes and UTF8 key order", () => {
    const value = parseJson(golden.nativeInput);
    expect(stringifyJson(value)).toBe(golden.nativeBody);
    expect(canonicalHash(value)).toBe(golden.nativeHash);
    expect(numberText(value.z)).toBe("9007199254740993");
    expect(integer(parseJson("1000000000000"))).toBe(1_000_000_000_000);
    expect(integer(parseJson("1e3"))).toBeUndefined();
    expect(integer(parseJson("1.0"))).toBeUndefined();
    expect(integer(parseJson("9223372036854775808"))).toBeUndefined();
  });
  test("known zero and unknown counters stay different; malformed evidence rejected", () => {
    const e = structuredClone(inputs[1]!);
    const zero = canonicalHash(e);
    delete e.usage!.raw.cacheReadTokens;
    expect(canonicalHash(e)).not.toBe(zero);
    e.usage!.raw.inputTokens = "1000000000001";
    expect(() => validateEvent(e)).toThrow("invalid typed event evidence");
    const bad = { ...inputs[0]!, coverage: { code: "also", count: "1" } };
    expect(() => validateEvent(bad)).toThrow("exactly one");
    expect(() => validateBatch({ version: 1, id: "b", events: [inputs[0]!, inputs[0]!] })).toThrow(
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
    const s = new Store(dir);
    stores.push(s);
    expect(s.deviceId()).toBe(event().deviceId);
    expect(s.events()).toEqual(golden.observations);
    const pending = s.pendingBatch()!;
    expect(encodeBatch(pending)).toBe(encodeBatch(golden.pendingBatch));
    s.acknowledge(pending, ack(pending));
    expect(s.pendingBatch()!.events[0]!.revision).toBe("2");
    s.observe({ ...event("persisted", "2"), observeTime: "2026-10-24T12:00:00Z" });
    expect(s.events().length).toBe(2);
    s.observe(event("persisted", "3"));
    const third = s.events()[2]!;
    expect(third.revision).toBe("3");
    expect(third.baseRevision).toBe("2");
    expect(third.baseHash).toBe(
      golden.observations[1].baseHash === canonicalHash(golden.observations[0])
        ? canonicalHash(golden.observations[1])
        : "invalid-Go-fixture",
    );
    expect((s.db.query("PRAGMA user_version").get() as any).user_version).not.toBe(0);
  });
  test("fresh observations produce exactly the Go event IDs and chains", () => {
    const s = store();
    s.observe(event("persisted", "1"));
    s.observe(event("persisted", "2"));
    expect(s.events()).toEqual(golden.observations);
  });
  test("235 observations upload bounded deltas and survive lost ACK restart", () => {
    const dir = temp();
    let s = new Store(dir);
    for (let i = 0; i < 235; i++) s.observe(event("entity-" + i));
    const original = s.pendingBatch()!,
      body = encodeBatch(original);
    s.close();
    s = new Store(dir);
    stores.push(s);
    expect(encodeBatch(s.pendingBatch()!)).toBe(body);
    expect(() => s.acknowledge(original, { batchId: original.id, receipts: [] })).toThrow(
      "incomplete",
    );
    const sizes: number[] = [];
    for (let b = s.pendingBatch(); b; b = s.pendingBatch()) {
      sizes.push(b.events.length);
      expect(Buffer.byteLength(encodeBatch(b))).toBeLessThan((1 << 20) + 4096);
      s.acknowledge(b, ack(b));
      s.acknowledge(b, ack(b));
    }
    expect(sizes).toEqual([100, 100, 35]);
    s.observe(event("entity-0"));
    expect(s.pendingBatch()).toBeNull();
    s.observe(event("entity-0", "2"));
    expect(s.pendingBatch()!.events).toHaveLength(1);
    const totals = s.status(),
      actual = s.db.query("SELECT SUM(length(body)) AS bytes FROM events").get() as any;
    expect(totals.normalizedBytes).toBe(actual.bytes);
  });
  test("recursive 413 splits preserve event order and byte identity on retries", () => {
    const s = store();
    for (let i = 1; i <= 8; i++) s.observe(event("same", String(i)));
    const original = s.pendingBatch()!,
      ids = original.events.map((e) => e.id!);
    s.splitBatch(original);
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const b = s.pendingBatch();
      if (!b) break;
      expect(encodeBatch(s.pendingBatch()!)).toBe(encodeBatch(b));
      if (b.events.length > 1) {
        s.splitBatch(b);
        continue;
      }
      seen.push(b.events[0]!.id!);
      expect(() => s.splitBatch(b)).toThrow("retained");
      s.acknowledge(b, ack(b));
    }
    expect(seen).toEqual(ids);
    expect(s.status().pending).toBe(0);
    const e = s.events()[0]!;
    s.put(e);
    expect(() => s.put({ ...e, coverage: { code: "test", count: "99" } })).toThrow(
      "identity conflicts",
    );
  });
});

describe("durable evidence and account pins", () => {
  test("raw BLOBs deduplicate, enforce shared legacy cap and reject corruption", () => {
    const dir = temp();
    let s = new Store(dir);
    const hash = s.putBlob(Buffer.from("before"));
    s.putBlob(null);
    s.close();
    s = new Store(dir);
    stores.push(s);
    expect(s.blob(hash).toString()).toBe("before");
    expect(statSync(join(dir, "ledger.sqlite")).mode & 0o777).toBe(0o600);
    s.db.query("UPDATE blob_totals SET total_bytes=? WHERE id=1").run(256 << 20);
    expect(s.putBlob(Buffer.from("before"))).toBe(hash);
    expect(() => s.putBlob(Buffer.from("new"))).toThrow("capacity");
    s.db.exec("DELETE FROM blobs; UPDATE blob_totals SET total_bytes=0 WHERE id=1");
    const legacy = join(dir, "blobs");
    mkdirSync(legacy);
    writeFileSync(join(legacy, hash), "before");
    const padding = join(legacy, ".pending-legacy");
    const fd = openSync(padding, "w");
    closeSync(fd);
    truncateSync(padding, (256 << 20) - 6);
    expect(() => s.putBlob(Buffer.from("new"))).toThrow("capacity");
    expect(s.putBlob(Buffer.from("before"))).toBe(hash);
    writeFileSync(join(legacy, hash), "changed");
    expect(() => s.blob(hash)).toThrow("hash mismatch");
    expect(() => s.blob("../ledger.sqlite")).toThrow("invalid evidence hash");
  });
  test("100 sessions share one registry and preserve old account pins after rotation", () => {
    process.env.KIMCHI_BRIDGE_HOME = temp();
    const c = account();
    const before = stateDir(c),
      pin = sessionStateDir(c, "codex", "old");
    expect(pin).toBe(before);
    const rotated = account(c.actorId, "rotated");
    expect(stateDir(rotated)).toBe(before);
    const next = account();
    expect(stateDir(next)).not.toBe(before);
    expect(sessionStateDir(next, "codex", "old")).toBe(before);
    for (let i = 0; i < 100; i++) sessionStateDir(c, "codex", String(i));
    expect(existsSync(join(stateRoot(), "session-accounts"))).toBe(false);
    mkdirSync(join(stateRoot(), "session-accounts"));
    const old = randomUUID();
    writeFileSync(
      join(stateRoot(), "session-accounts", stableId("codex", "legacy") + ".json"),
      JSON.stringify(old),
    );
    expect(basename(sessionStateDir(c, "codex", "legacy"))).toBe(old);
    expect(basename(sessionStateDir(c, "claude-code", "legacy"))).toBe(basename(before));
  });
  test("private atomic config saves drop an earlier release's key and runtime and decode only OTLP", () => {
    process.env.KIMCHI_BRIDGE_HOME = temp();
    const c = { ...account(), disabled: true };
    saveConfig({
      ...c,
      apiKey: "earlier-release-key",
      enabled: true,
      runtimeExecutable: "/managed/runtime",
      runtimeRevision: randomUUID(),
    } as Config);
    expect(loadConfig()).toEqual(c);
    expect(readFileSync(join(stateRoot(), "config.json"), "utf8")).not.toContain(
      "earlier-release-key",
    );
    expect(statSync(join(stateRoot(), "config.json")).mode & 0o777).toBe(0o600);
    const decoded = decodeOtlp(
      JSON.stringify({ otlpUrl: "https://collector.example/v1/logs", runtimeExecutable: "/x" }),
    );
    expect(decoded).toEqual({
      otlpUrl: "https://collector.example/v1/logs",
      otlpHeaders: undefined,
    });
    expect(() => decodeOtlp("x".repeat((32 << 10) + 1))).toThrow("too large");
    expect(() => decodeOtlp(JSON.stringify({ otlpUrl: "http://collector.example" }))).toThrow(
      "HTTPS",
    );
  });
});

test("a repository host may carry its HTTPS port, as the snapshot route accepted", () => {
  for (const host of ["github.com", "ghe.example.com:8443", "gitlab.example.com:1", "h:65535"])
    expect([host, validHost(host)]).toEqual([host, true]);
  for (const host of [
    "",
    ":443",
    "h:",
    "h:0",
    "h:65536",
    "h:123456",
    "h:1:2",
    "h:+1",
    "h:1a",
    "a b",
    "h/x",
    "u@h",
    "h:１",
  ])
    expect([host, validHost(host)]).toEqual([host, false]);
});
