// What the Kimchi harness records about a session, as the code here reads it: the journal records
// of a work, the account and repository they were captured under, and the part of the harness's
// cost report that says where each request's cost goes. The harness writes these; nothing here
// touches a file, a credential or the network.

/** The Kimchi account a record was captured under. */
export interface WorkAccount {
  apiUrl: string;
  organizationId: string;
  userId: string;
}
/** An account and the local repository (Git's common directory) a work belongs to. */
export interface WorkScope {
  account: WorkAccount;
  repository: string;
}
/**
 * Whether two accounts are the same one. The harness decides: an account captured before the
 * platform API moved to its region's API origin still names the old address.
 */
export type SameAccount = (left: WorkAccount, right: WorkAccount) => boolean;

/** One user input and what it caused, with the evidence for the work it was given. */
export interface WorkSegment {
  id: string;
  attribution: "explicit" | "inferred" | "session" | "unknown";
  reason: string;
}

/** A journal record. Beyond its identity, a record's fields depend on its type and are checked where read. */
export interface WorkRecord {
  version: 1;
  type: string;
  workId: string;
  sessionId: string;
  [key: string]: unknown;
}
/** A record as the ledger stores it: its JSON and the hash that identifies it. */
export interface StoredRecord {
  body: string;
  recordHash: string;
}

/** A pull or merge request as the harness last saw it at its provider. */
export interface WorkPullRequest {
  provider?: "github" | "gitlab";
  /** Provider IDs belong to the target repository, including fork contributions. */
  id?: string;
  repositoryId?: string;
  url: string;
  number: number;
  /** The provider's title, cut to 1,024 characters. Display metadata for uploads only; older links omit it. */
  title?: string;
  /** The author's login: GitHub `user.login`, GitLab `author.username`. Like `title`, uploaded only. */
  author?: string;
  /** The Jira keys the PR's head branch names, at most 20; the branch name itself is not kept. Uploaded only. */
  branchIssueKeys?: string[];
  state: "open" | "closed" | "merged";
  repository: string;
  host: string;
  headSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  checkedAt: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX = "0123456789abcdef";
const hex = (text: string) => Array.from(text).every((character) => HEX.includes(character));
const digit = (character: string | undefined) =>
  character !== undefined && character >= "0" && character <= "9";

/** A UUID of versions 1 to 8, in either case: the identity of works, requests, links and segments. */
export function isWorkId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false;
  const parts = value.toLowerCase().split("-");
  return (
    parts.length === 5 &&
    [8, 4, 4, 4, 12].every((length, index) => parts[index]!.length === length) &&
    parts.every(hex) &&
    "12345678".includes(parts[2]![0]!) &&
    "89ab".includes(parts[3]![0]!)
  );
}

/** A lowercase hex SHA-256 digest, as Kimchi writes hashes, fingerprints and boundaries. */
export function isSha256Hex(value: string): boolean {
  return value.length === 64 && hex(value);
}

export function isWorkSegment(value: unknown): value is WorkSegment {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.reason === "string" &&
    !!value.reason &&
    (value.attribution === "explicit" ||
      value.attribution === "inferred" ||
      value.attribution === "session" ||
      value.attribution === "unknown")
  );
}

export function isWorkAccount(value: unknown): value is WorkAccount {
  return (
    isObject(value) &&
    typeof value.apiUrl === "string" &&
    isWorkId(value.organizationId) &&
    isWorkId(value.userId)
  );
}

export function isWorkScope(value: unknown): value is WorkScope {
  return (
    isObject(value) &&
    isWorkAccount(value.account) &&
    typeof value.repository === "string" &&
    !!value.repository
  );
}

export function sameScope(left: WorkScope, right: WorkScope, sameAccount: SameAccount): boolean {
  return left.repository === right.repository && sameAccount(left.account, right.account);
}

// YYYY-MM-DDTHH:MM:SS, an optional fraction of one to nine digits, then Z or a numeric offset.
function timestampShape(value: string): boolean {
  const shape = "dddd-dd-ddTdd:dd:dd";
  for (let index = 0; index < shape.length; index++)
    if (shape[index] === "d" ? !digit(value[index]) : value[index] !== shape[index]) return false;
  let rest = value.slice(shape.length);
  if (rest.startsWith(".")) {
    let end = 1;
    while (digit(rest[end])) end++;
    if (end === 1 || end > 10) return false;
    rest = rest.slice(end);
  }
  return (
    rest === "Z" ||
    (rest.length === 6 &&
      (rest[0] === "+" || rest[0] === "-") &&
      digit(rest[1]) &&
      digit(rest[2]) &&
      rest[3] === ":" &&
      digit(rest[4]) &&
      digit(rest[5]))
  );
}

/** The milliseconds of a timestamp the harness wrote, or undefined when it is not one. */
export function time(value: unknown): number | undefined {
  if (typeof value !== "string" || !timestampShape(value)) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  // Date.parse accepts impossible dates such as February 30 by rolling into the next month.
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) ? parsed : undefined;
}

/** Protobuf timestamps start at year 1. */
export function validTime(value: unknown): value is string {
  return typeof value === "string" && Number(value.slice(0, 4)) >= 1 && time(value) !== undefined;
}

/** A PR cost upload bounds a PR's title and its author's login in characters, as the server counts them. */
const MAX_TITLE_CHARACTERS = 1024;
const MAX_AUTHOR_CHARACTERS = 255;
/** A title cut to the upload bound; a missing, empty or non-text title is unknown. */
export function pullRequestTitle(value: unknown): string | undefined {
  // Whole characters: cutting UTF-16 units could leave half a surrogate pair, which the server rejects.
  return typeof value === "string" && value
    ? Array.from(value).slice(0, MAX_TITLE_CHARACTERS).join("")
    : undefined;
}
/** An author login; one past the bound is unknown rather than cut, because a shorter login names someone else. */
export function pullRequestAuthor(value: unknown): string | undefined {
  return typeof value === "string" && value && Array.from(value).length <= MAX_AUTHOR_CHARACTERS
    ? value
    : undefined;
}

/** A Git object name, SHA-1 or SHA-256, in either case. */
export function isGitHash(value: string): boolean {
  return (value.length === 40 || value.length === 64) && hex(value.toLowerCase());
}

/** A provider's numeric ID as text: a positive integer of at most 20 digits. */
export function providerId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 20 &&
    value[0] !== "0" &&
    Array.from(value).every(digit)
  )
    return value;
}

const pathCharacter = (character: string) =>
  digit(character) ||
  (character >= "a" && character <= "z") ||
  (character >= "A" && character <= "Z") ||
  character === "_" ||
  character === "." ||
  character === "-";
/** A repository's path at its provider: owner/name on GitHub, any depth of groups on GitLab. */
export function repositoryPath(value: unknown, provider?: "github" | "gitlab"): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    (provider !== "github" || segments.length === 2) &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        Array.from(segment).every(pathCharacter) &&
        segment !== "." &&
        segment !== "..",
    )
  );
}

/** A URL with an allowed protocol and no credentials, query or fragment; otherwise undefined. */
export function plainURL(
  value: unknown,
  protocols: readonly string[] = ["https:"],
): URL | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      protocols.includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return url;
  } catch {}
  return undefined;
}

/** A PR's identity across observations: its provider ID where one is known, else its URL. */
export function pullRequestKey(pr: {
  provider?: unknown;
  host?: unknown;
  id?: unknown;
  url?: unknown;
}): string {
  const id = typeof pr.id === "string" && typeof pr.host === "string" ? pr.id : pr.url;
  return JSON.stringify([pr.provider ?? "github", pr.host, id]);
}
