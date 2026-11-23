import { describe, expect, it } from "bun:test";
import { mergePullRequestLinks, pullRequestLabel } from "../../src/ledger/links.js";

describe("saved provider links", () => {
  const old = {
    provider: "github",
    host: "github.com",
    id: "42",
    url: "https://github.com/team/old/pull/7",
    checkedAt: "2026-10-01T10:00:00Z",
  };
  it("keeps different providers and hosts separate even when IDs match", () => {
    const otherHost = {
      ...old,
      host: "enterprise.example",
      url: "https://enterprise.example/team/old/pull/7",
    };
    const otherProvider = {
      ...old,
      provider: "gitlab",
      url: "https://github.com/team/old/-/merge_requests/7",
    };
    expect(mergePullRequestLinks([old, otherHost, otherProvider])).toHaveLength(3);
  });
  it("does not combine conflicting provider IDs at one URL", () => {
    expect(mergePullRequestLinks([old, { ...old, id: "43" }])).toHaveLength(2);
  });
  it("keeps the renamed URL when an older observation is replayed", () => {
    const renamed = {
      ...old,
      url: "https://github.com/team/new/pull/7",
      checkedAt: "2026-10-02T10:00:00Z",
    };
    expect(mergePullRequestLinks([renamed], [old])).toEqual([renamed]);
  });
});

it.each([false, true])(
  "keeps the valid PR observation when a timestamp is damaged (valid first: %s)",
  (validFirst) => {
    const valid = {
      url: "https://github.com/example/repo/pull/7",
      state: "merged",
      checkedAt: "2026-10-04T10:00:00Z",
    };
    const damaged = { ...valid, state: "open", checkedAt: "invalid-history" };
    const rows = validFirst ? [valid, damaged] : [damaged, valid];
    // Recovery can replay records in either order.
    expect(mergePullRequestLinks(rows)).toEqual([valid]);
  },
);

describe("pullRequestLabel", () => {
  it("labels GitHub pull requests and GitLab merge requests", () => {
    expect(pullRequestLabel({ provider: "github", number: 7, state: "open" })).toBe("PR #7 open");
    expect(pullRequestLabel({ provider: "gitlab", number: 8, state: "merged" })).toBe(
      "MR !8 merged",
    );
  });
  // Records saved before the provider field was captured have no provider; they must stay valid
  // inputs, as they were for Kimchi's own footer and /work callers before the move.
  it("accepts records without a captured provider", () => {
    expect(pullRequestLabel({ number: 7, state: "open" })).toBe("PR #7 open");
  });
});
