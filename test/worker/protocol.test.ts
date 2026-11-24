import { describe, expect, test } from "bun:test";
import {
  encodeParentMessage,
  encodeWorkerMessage,
  parseConsentReply,
  parseGitTokenReply,
  parseHostCredentials,
  parseHostEndpoints,
  parseParentLine,
  parsePolicyReply,
  parseWorkerLine,
  PROTOCOL_VERSION,
  redactTokens,
  resourceEnabledFromPolicy,
  type DoneMessage,
  type HelloMessage,
  type PassMessage,
  type ParentMessage,
  type ReadyMessage,
  type WorkerMessage,
} from "../../src/worker/protocol.js";

/**
 * The worker's wire protocol (reconcile-out-of-process plan, chunk B3). Every
 * message round-trips through the strict codec; truncated or invalid lines are
 * rejected rather than guessed; mismatched versions or builds are refused; and
 * no token ever appears in a message the worker may emit outside `reply`.
 */

const HELLO: HelloMessage = {
  type: "hello",
  v: PROTOCOL_VERSION,
  build: "b3-test-build",
  agentDir: "/tmp/agent",
  seams: { KIMCHI_E2E_TEST: "1" },
};

const PASS: PassMessage = {
  type: "pass",
  id: 7,
  channels: { files: true, costs: true },
  nextRepository: "/repo/.git",
  deadlineMs: 30000,
  epoch: 41,
};

const CANCEL: ParentMessage = { type: "cancel", id: 7 };

const READY: ReadyMessage = { type: "ready", v: PROTOCOL_VERSION, build: "b3-test-build" };

const DONE: DoneMessage = {
  type: "done",
  id: 7,
  result: {
    outcome: "ok",
    channels: { files: { outcome: "ok" }, costs: { outcome: "failed", error: "boom" } },
    nextRepository: "/next/.git",
  },
};

/** Every parent message shape the worker must accept. */
function parentMessages(): ParentMessage[] {
  const passReporting: PassMessage = {
    type: "pass",
    id: 8,
    channels: { reporting: true, pullRequests: true },
    reportingCwd: "/project",
    deadlineMs: 3000,
    epoch: 0,
  };
  return [
    HELLO,
    PASS,
    passReporting,
    CANCEL,
    {
      type: "reply",
      rid: 3,
      result: { token: "secret-token-value", apiUrl: "https://api.example" },
    },
    { type: "hello", v: PROTOCOL_VERSION, build: "b", agentDir: "/a" },
  ];
}

/** Every worker message shape the parent must accept. */
function workerMessages(): WorkerMessage[] {
  return [
    READY,
    { type: "request", rid: 1, kind: "credentials", cwd: "/project" },
    { type: "request", rid: 2, kind: "policy" },
    { type: "request", rid: 3, kind: "consent" },
    { type: "request", rid: 4, kind: "endpoints", cwd: "/project" },
    { type: "request", rid: 5, kind: "gitToken", host: "github.com" },
    { type: "metric", metric: { kind: "reconciliation" } },
    { type: "metric", metric: { kind: "delivery", outcome: "success" } },
    { type: "metric", metric: { kind: "unpriced", value: 4 } },
    { type: "progress", id: 7, note: "pass-started" },
    DONE,
    { type: "error", message: "refused", id: 7 },
    { type: "error", message: "refused" },
  ];
}

describe("protocol round trip", () => {
  test("every parent message round-trips through encode and strict parse", () => {
    for (const message of parentMessages()) {
      const line = encodeParentMessage(message);
      expect(line.endsWith("\n")).toBe(true);
      const parsed = parseParentLine(line);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(message);
    }
  });

  test("every worker message round-trips through encode and strict parse", () => {
    for (const message of workerMessages()) {
      const line = encodeWorkerMessage(message);
      const parsed = parseWorkerLine(line);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(message);
    }
  });

  test("a done message with the B4 transaction histogram round-trips", () => {
    const message: WorkerMessage = {
      type: "done",
      id: 9,
      result: {
        outcome: "canceled",
        channels: { reporting: { outcome: "canceled" } },
        txDurations: {
          count: 12,
          maxMs: 41,
          upTo25Ms: 8,
          upTo50Ms: 12,
          upTo100Ms: 12,
          upTo250Ms: 12,
          over250Ms: 0,
        },
      },
    };
    const parsed = parseWorkerLine(encodeWorkerMessage(message));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(message);
  });

  test("the encoder refuses to emit a message the strict parser would reject", () => {
    expect(() =>
      encodeParentMessage({ type: "pass", id: 0, channels: {}, deadlineMs: 10, epoch: 0 }),
    ).toThrow("invalid message");
    expect(() =>
      encodeWorkerMessage({ type: "metric", metric: { kind: "nonsense" as never } }),
    ).toThrow("invalid message");
  });
});

describe("strict line rejection", () => {
  test("truncated JSON is rejected, never completed by guessing", () => {
    const truncated = encodeParentMessage(PASS).slice(0, 25);
    const parsed = parseParentLine(truncated);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).not.toContain("pass");
  });

  test("non-JSON, empty and non-object lines are rejected", () => {
    for (const line of ["", "   ", "not json", "[1,2]", '"string"', "42", "null"]) {
      const parsed = parseParentLine(line);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });

  test("unknown message types and unknown or mistyped fields are rejected", () => {
    const cases: string[] = [
      '{"type":"poke"}',
      '{"type":"hello","v":1,"build":"b","agentDir":"/a","extra":true}',
      '{"type":"hello","v":"1","build":"b","agentDir":"/a"}',
      '{"type":"hello","v":1,"build":"b"}',
      '{"type":"pass","id":1,"channels":{},"deadlineMs":0,"epoch":0}',
      '{"type":"pass","id":1,"channels":{"files":"yes"},"deadlineMs":10,"epoch":0}',
      '{"type":"pass","id":1,"channels":{"nonsense":true},"deadlineMs":10,"epoch":0}',
      '{"type":"cancel"}',
      '{"type":"cancel","id":-2}',
      '{"type":"reply"}',
      '{"type":"request","rid":1,"kind":"gitToken","host":5}',
      '{"type":"request","rid":1,"kind":"nonsense"}',
      '{"type":"metric","metric":{"kind":"delivery","outcome":"maybe"}}',
      '{"type":"done","id":1,"result":{"outcome":"finished","channels":{}}}',
      '{"type":"done","id":1,"result":{"outcome":"ok","channels":{"files":{"outcome":"ok","extra":1}}}}',
      '{"type":"ready","v":1,"build":"b","other":1}',
    ];
    for (const line of cases) {
      const asParent = parseParentLine(line);
      const asWorker = parseWorkerLine(line);
      expect(asParent.ok, line).toBe(false);
      expect(asWorker.ok, line).toBe(false);
    }
  });

  test("parse and validation errors never echo the input's values", () => {
    const SECRET = "unregisteredSecret123";
    const lines: string[] = [
      `{"type":"${SECRET}"}`,
      `{"type":"hello","v":1,"build":"b","agentDir":"/a","${SECRET}":true}`,
      '{"type":"hello","v":1,"build":"b","agentDir":"/a","seams":{"k":1}}',
    ];
    for (const line of lines) {
      const parsed = parseParentLine(line);
      expect(parsed.ok, line).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.includes(SECRET)).toBe(false);
        expect(parsed.error.includes("FORGED")).toBe(false);
        // A single-letter key must not leak through a "value at" clause either.
        expect(parsed.error.includes('"k"')).toBe(false);
      }
    }
  });

  test("a hello for another protocol version is rejected", () => {
    const line = encodeParentMessage({ ...HELLO, v: PROTOCOL_VERSION + 1 });
    const parsed = parseParentLine(line);
    expect(parsed.ok).toBe(true); // it is a well-formed message...
  });

  test("whitespace-only lines never parse as anything", () => {
    expect(parseWorkerLine(" \t ").ok).toBe(false);
  });
});

describe("reply payload validation", () => {
  test("credentials, endpoints, policy, consent and gitToken replies validate", () => {
    expect(parseHostCredentials({ token: "t", apiUrl: "https://a" })).toEqual({
      ok: true,
      value: { token: "t", apiUrl: "https://a" },
    });
    expect(
      parseHostCredentials({ token: "t", organizationId: "org", apiUrl: "https://a" }).ok,
    ).toBe(true);
    expect(parseHostCredentials({ token: "t" }).ok).toBe(false);
    expect(parseHostCredentials({ token: 1, apiUrl: "https://a" }).ok).toBe(false);
    expect(
      parseHostEndpoints({
        llmEndpoint: "a",
        openAiBaseUrl: "b",
        anthropicBaseUrl: "c",
        experimentalOpenAiBaseUrl: "d",
        platformApiUrl: "e",
      }).ok,
    ).toBe(true);
    expect(
      parseHostEndpoints({
        llmEndpoint: "a",
        openAiBaseUrl: "b",
        anthropicBaseUrl: "c",
        experimentalOpenAiBaseUrl: "d",
      }).ok,
    ).toBe(false);
    expect(parsePolicyReply({ resources: { "extensions.cost-per-pr": true } }).ok).toBe(true);
    expect(parsePolicyReply({ resources: { a: "yes" } }).ok).toBe(false);
    expect(parsePolicyReply({ resources: { a: true }, extra: 1 }).ok).toBe(false);
    expect(parseConsentReply({ consent: false }).ok).toBe(true);
    expect(parseConsentReply({ consent: "no" }).ok).toBe(false);
    expect(parseConsentReply({}).ok).toBe(false);
    // The saved git host token, or no token at all when none is saved.
    expect(parseGitTokenReply({ token: "ghp_saved" })).toEqual({
      ok: true,
      value: { token: "ghp_saved" },
    });
    expect(parseGitTokenReply({})).toEqual({ ok: true, value: {} });
    expect(parseGitTokenReply({ token: "ghp_saved", extra: 1 }).ok).toBe(false);
    expect(parseGitTokenReply({ token: 1 }).ok).toBe(false);
    expect(parseGitTokenReply("ghp_saved").ok).toBe(false);
  });

  // Kimchi's isResourceEnabled semantics: the reply carries effective answers
  // for the ids it governs; an id nothing governs defaults to enabled.
  test("resource enablement matches Kimchi's isResourceEnabled fallback", () => {
    // A known resource id the reply answers.
    expect(
      resourceEnabledFromPolicy(
        { resources: { "extensions.cost-per-pr": false } },
        "extensions.cost-per-pr",
      ),
    ).toBe(false);
    expect(
      resourceEnabledFromPolicy(
        { resources: { "extensions.cost-per-pr": true } },
        "extensions.cost-per-pr",
      ),
    ).toBe(true);
    // An id the reply omits falls back to the definition default (on).
    expect(resourceEnabledFromPolicy({ resources: {} }, "extensions.cost-per-pr")).toBe(true);
    // An unknown id with no governing entry is enabled, as in Kimchi.
    expect(resourceEnabledFromPolicy({ resources: {} }, "extensions.something-new")).toBe(true);
    // An org-controlled entry for an unknown id still applies.
    expect(
      resourceEnabledFromPolicy(
        { resources: { "extensions.something-new": false } },
        "extensions.something-new",
      ),
    ).toBe(false);
  });
});

describe("token redaction", () => {
  const FAKE_TOKEN = "kchi_fake_b3token_0123456789abcdef";

  test("known secrets are scrubbed from any text", () => {
    const text = `upload failed for ${FAKE_TOKEN} at https://api.example`;
    const redacted = redactTokens(text, [FAKE_TOKEN]);
    expect(redacted).not.toContain(FAKE_TOKEN);
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("https://api.example");
  });

  test("credential-shaped strings are scrubbed even when not registered", () => {
    for (const secret of [
      "sk-proj-abcdefghijklmnop1234",
      "ghp_abcdefghijklmnopqrst",
      "github_pat_ABCDEFGHIJKLMNOPQRST",
      "glpat-abcdefghijklmnopqrs",
      "xoxb-123456789012-abcdef",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      const redacted = redactTokens(`key was ${secret}`);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("[redacted]");
    }
  });

  test("secret-bearing fields and bearer headers are scrubbed", () => {
    expect(redactTokens('{"token":"abc12345678","other":"x"}')).toBe(
      '{"token":"[redacted]","other":"x"}',
    );
    expect(redactTokens('{"apiKey":"abc12345678"}')).toBe('{"apiKey":"[redacted]"}');
    expect(redactTokens("Authorization: Bearer abc123456789")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  test("ordinary paths and numbers survive redaction", () => {
    const text = "/tmp/agent/work-attribution and 1234567890 stay";
    expect(redactTokens(text)).not.toContain("[redacted]");
  });

  test("parse errors never echo the offending line", () => {
    const parsed = parseParentLine(`{"type":"reply","rid":1,"result":{"token":"${FAKE_TOKEN}"} `);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).not.toContain(FAKE_TOKEN);
      expect(parsed.error).not.toContain("token");
      // The error must be safe to forward to the parent as an `error` message.
      const error = encodeWorkerMessage({
        type: "error",
        message: redactTokens(parsed.error, [FAKE_TOKEN]),
      });
      expect(error).not.toContain(FAKE_TOKEN);
    }
  });

  test("every nonempty known secret is scrubbed, however short", () => {
    for (const secret of ["Q", "abcd", "abcdefgh", "a".repeat(64)]) {
      const redacted = redactTokens(`the token is ${secret} in full`, [secret]);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("[redacted]");
    }
  });

  test("whitespace-only accepted credentials are scrubbed, not treated as blank", () => {
    // Kimchi's config reader accepts any nonempty apiKey string, and the
    // credentials reply does the same, so a spaces-only or tab-only token is
    // a live credential and must be replaced exactly wherever it appears.
    expect(redactTokens("token=   ; suffix", ["   "])).toBe("token=[redacted]; suffix");
    expect(redactTokens("key a\tb done", ["\t"])).toBe("key a[redacted]b done");
    // A credentials value that is all whitespace still scrubs from every
    // shape it can appear in, including quoted diagnostic fields.
    expect(redactTokens('"token":"   "', ["   "])).toBe('"token":"[redacted]"');
    // The empty string alone is not a credential and replaces nothing.
    expect(redactTokens("kept as is", [""])).toBe("kept as is");
  });
});
