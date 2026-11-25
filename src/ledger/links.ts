/** Minimal shape of Kimchi's WorkPullRequest that pullRequestLabel names; the full type stays in Kimchi.
 * The state and provider unions mirror the original in Kimchi's pull-request-status/pull-requests.ts,
 * and `provider` stays optional so records saved before it was captured remain valid inputs. */
interface WorkPullRequest {
  provider?: "github" | "gitlab";
  number: number;
  state: "open" | "closed" | "merged";
}

interface PullRequestObservation {
  provider?: unknown;
  host?: unknown;
  id?: unknown;
  url?: unknown;
  checkedAt?: unknown;
}

/** `PR #7 open` or `MR !7 merged`, as `/work` and the footer name a link; the footer drops the state when space runs out. */
export function pullRequestLabel(
  pr: Pick<WorkPullRequest, "provider" | "number" | "state">,
): string {
  return `${pr.provider === "gitlab" ? "MR !" : "PR #"}${pr.number} ${pr.state}`;
}

export function pullRequestKey(pr: PullRequestObservation): string {
  const id = typeof pr.id === "string" && typeof pr.host === "string" ? pr.id : pr.url;
  return JSON.stringify([pr.provider ?? "github", pr.host, id]);
}

/** The parsed observation time: an unparseable `checkedAt` ranks weakest (it loses to any
 *  finite time), matching the merge's existing newest-observation-wins rule. */
function observationAt(item: PullRequestObservation): number {
  const at = typeof item.checkedAt === "string" ? Date.parse(item.checkedAt) : Number.NaN;
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** True when `a` STRICTLY outranks `b` in the merge's order: a NEWER checkedAt wins; an
 *  exact tie is broken by identity strength — an observation bearing a PR id outranks a
 *  URL-only one (a confirmed GitHub identity beats an upgrade guess), regardless of which
 *  group arrived first. That one rule is what makes the incremental capture fold (the saved
 *  head's summary, then the touched rows) and the whole-row rebuild (every commit row in
 *  projection order) agree: the round-6 correctness-013 probe published `closed` from one
 *  path and `open` from the other on identical rows. Every remaining exact tie — equal
 *  checkedAt, equal identity strength — keeps the merge's long-standing behavior: the
 *  observation processed later wins. Rows only ever accumulate links and each row merges
 *  its own observations temporally, so the later observation is the temporally newest
 *  evidence; two DISTINCT rows carrying conflicting equal-timestamp id-bearing observations
 *  of one alias remain inherently ambiguous, and each path picks a valid merge of them. */
function outranks(a: PullRequestObservation, b: PullRequestObservation): boolean {
  const left = observationAt(a);
  const right = observationAt(b);
  if (left !== right) return left > right;
  return typeof a.id === "string" && typeof b.id !== "string";
}

/** Upgrade URL-only records, and keep one provider identity across repository renames. */
export function mergePullRequestLinks<T extends PullRequestObservation>(...groups: T[][]): T[] {
  // Every observation is folded in the total rank order above — strongest first — instead of
  // the caller's grouping order, so the merge is a function of the observation SET, not of the
  // order its groups (head summary, touched rows, whole-row scans) happened to arrive in.
  const ranked = groups
    .flatMap((group) => group)
    .filter(
      (item): item is T => typeof item?.url === "string" && typeof item?.checkedAt === "string",
    )
    .map((item) => ({ item, at: observationAt(item), hasId: typeof item.id === "string" ? 1 : 0 }));
  // Strongest first, newest observation first; the sort is STABLE (no serialization tiebreak
  // here), so observations that rank equal keep the caller's first-seen order in the merged
  // output exactly as before — the total order above decides which of two conflicting
  // observations wins the merge, never which one appears first.
  ranked.sort((left, right) => right.at - left.at || right.hasId - left.hasId);
  const merged = new Map<string, T>();
  const urls = new Map<string, string>();
  for (const { item } of ranked) {
    // The collection above guaranteed both fields are strings; the re-check only carries
    // that narrowing through the intermediate array for the map lookups below.
    if (typeof item.url !== "string" || typeof item.checkedAt !== "string") continue;
    const key = pullRequestKey(item);
    const sameUrl = merged.get(urls.get(item.url) ?? key);
    const previous = merged.get(key) ?? (!sameUrl?.id || !item.id ? sameUrl : undefined);
    const update =
      !previous || !outranks(previous, item) ? { ...previous, ...item } : { ...item, ...previous };
    const updatedKey = pullRequestKey(update);
    if (previous) {
      if (pullRequestKey(previous) !== updatedKey) merged.delete(pullRequestKey(previous));
      if (typeof previous.url === "string") urls.set(previous.url, updatedKey);
    }
    merged.set(updatedKey, update);
    urls.set(item.url, updatedKey);
  }
  return [...merged.values()];
}
