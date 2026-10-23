# Kimchi PR-cost plugins

Two plugins for the official Claude Code and Codex CLIs. Both use one shared TypeScript recorder and SQLite outbox. Native hooks and Claude mod timers run short commands; no daemon or inference proxy is required. Inference uses the client’s existing provider. Normalized work records go directly to the Cast API.

This is an unpublished release candidate. Reporting needs the companion PR-cost API, console and generated RBAC changes. An older server leaves records queued locally.

## Install and authenticate

Requires the official selected clients, authenticated `gh` access to this private repository, and macOS or glibc Linux on arm64/x64. Downloaded plugins contain one self-contained executable; users do not install Node, Bun, pnpm or Go. Native plugin trust remains the client’s ordinary setup step.

The shared entry point is [Kimchi’s installer change](https://github.com/getkimchi/kimchi/pull/1524), with `--adapters claude`, `--adapters codex` or `--adapters both`. Until that change ships, use its pinned preview:

```sh
curl -fsSL https://raw.githubusercontent.com/getkimchi/kimchi/7fbbb81b7876d4734ad7d423fad8fc373aa47417/scripts/install.sh | bash -s -- --adapters both
```

`KIMCHI_VERSION` and `KIMCHI_ADAPTERS_VERSION` select independent releases. The preview currently downloads published adapter releases; it does not install this uncommitted TypeScript candidate. The release bootstrap verifies checksums, rejects unsafe archive entries, and uses each client’s native plugin manager. Finish active coding sessions before an update or uninstall.

For a standalone installation, run `bash install.sh install both` from the release package. Choose `claude` or `codex` instead of `both` when needed. This does not require the Kimchi harness.

Install and update keep an already verified reporting account. Otherwise, the installer imports `KIMCHI_API_KEY` or the key in `~/.config/kimchi/config.json`. If no key exists, an interactive install opens browser login; a noninteractive install prints the login command. A key that fails verification leaves the existing configuration intact and reports an error.

```sh
kimchi-adapters login
kimchi-adapters status
```

Browser login opens Kimchi’s existing console flow, where you choose the organization and create a user-owned API key. The key is verified and saved only for reporting. This does not sign the Kimchi harness in or change its inference settings. The installer does not run `kimchi login`, which can reset a custom Kimchi inference endpoint.

Use `kimchi-adapters login --from-kimchi` to explicitly select your current saved Kimchi account. `--region eu` selects Europe for browser login; `login https://your-console.example` uses the existing self-hosted discovery flow. `--no-browser` prints the browser URL for manual opening. Project config and Claude/Codex inference credentials are never imported.

JSON configuration remains available as a backup. Supply a user-owned Kimchi key through a private file or password manager:

```json
{
  "apiUrl": "https://api.cast.ai",
  "apiKey": "YOUR-KIMCHI-API-KEY"
}
```

```sh
kimchi-adapters configure < /path/to/private/reporting.json
kimchi-adapters status
```

`KIMCHI_API_KEY` takes precedence for `configure` and explicit `--from-kimchi` imports. The existing key-verification endpoint discovers the organization; `/v1/me` confirms a matching user. An optional supplied `organizationId` must match. Select the regional/self-hosted reporting API origin when configuring JSON. Existing saved bearer configurations remain readable during upgrades.

Service-account keys are rejected. A normal Kimchi user key needs reporting permission; a restricted reporting-only key may fail the broader existing verification endpoint. Jira’s one-use connection key is not this credential. Account state is separated by verified endpoint, organization and user. Pre-login history stays local; changing login never relabels an existing native session.

## Quiet collection and outputs

Capture saves locally before returning, including file contents before edits. Claude’s mod schedules sync at startup, turn completion and every 30 seconds while open. Codex uses background lifecycle hooks. Sync makes one pass with an eight-second cooperative budget and a ten-second native timeout. Pending work waits for the next trigger when clients are closed. SQLite can finish an already-blocked operation after the cooperative deadline; the native timeout remains the final process bound.

```sh
kimchi-adapters status
kimchi-adapters disable
kimchi-adapters enable
kimchi-adapters flush
kimchi-adapters export jsonl > work.jsonl  # or export csv
kimchi-adapters update both v0.1.0-rc.9
kimchi-adapters uninstall codex
```

Hooks fail open without chat output, context injection or extra model calls. Status exposes gaps and queued uploads. Export contains normalized revisions; CSV protects formula cells. Optional `otlpUrl` and `otlpHeaders` send normalized OTLP/HTTP logs with independent credentials and receipts. A login to another endpoint, organization or user clears these exporter settings; key rotation within the same account preserves them. Existing enterprise exporters remain unchanged.

## Evidence and pricing

| Evidence           | Behavior                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work and plans     | Bind each session/turn/agent. Verified saved plan revisions can continue across clients and Git worktrees. Ambiguous matches stay separate. Start explicit new work with `New work: title` on the prompt’s first line. Only that title becomes metadata. |
| Requests and cache | Read registered native transcripts and exposed Claude telemetry. Preserve token buckets, IDs, model/route and missing fields. Duplicate streams revise one request; mod counters without request IDs stay supplementary.                                 |
| Tools and files    | Persist native IDs, outcomes, synchronous before-state and observed after-state. Confirm expected edit bytes conservatively. Shell activity, concurrent human changes, fuzzy patches and renames retain weaker evidence.                                 |
| Git, PR and Jira   | Match exact parent/child blobs only against newly observed commits. Host-bound read-only `gh`/`glab` discovery retains target repository and PR IDs, lifecycle and observed Jira keys.                                                                   |
| Cost and coverage  | Cast applies its existing rate catalog and PR/Jira accounting. API reference estimates remain separate from verified proxy charges; only exact owned aliases suppress duplicate estimates. Missing usage/prices stay unknown.                            |

Put portable plans in `plans/` or `.plans/`; native writes register actual revisions. Claude’s exposed plan-mode path is also registered. Refer to the registered file in the other client to continue the same work. A displayed plan alone is not a saved file.

Codex transcript usage supplies the financial records. `PostModelRequest` adds main-loop status and counter coverage, without another charge because it has no stable request ID. Its counters can include synthesized zeroes. Internal thread-title generation is outside this callback; its usage and cost remain unknown. Hidden gateway retries/routing, provider tool charges, subscription invoices and an exact request-to-tool join also remain limited by what the client exposes.

## Storage, delivery and privacy

Default state: `~/.local/state/kimchi-adapters`. Releases: `~/.local/share/kimchi-adapters`. Testing can override `KIMCHI_ADAPTERS_HOME` and `KIMCHI_ADAPTERS_PREFIX`. New observations and raw file bytes add SQLite rows, not one file per event/revision. Session pins share one SQLite registry. WAL/SHM files can exist while databases are open. Legacy JSON pins/blobs remain readable.

Uploads are immutable record deltas, normally at most 100 events/about 1 MiB. Exact durable batches survive lost acknowledgements. HTTP 413 splits retain event IDs, revisions and order. Server quotes, replay guards and PR/Jira projections use the existing PR-cost domain; PostgreSQL commits before ClickHouse insertion and the ACK. Replay repairs missing detail without a second charge.

Prompts, source/plan text, paths, file hashes, tool arguments/results and credentials are excluded from upload. Explicit work titles and provider PR metadata can contain human text. Raw local evidence shares a 256 MiB account cap across old/new storage and has a 4 MiB file limit. When sync runs, its hourly sweep removes raw evidence older than seven days across active and inactive accounts. Normalized records have a 1 GiB account cap; pending financial records are not age-deleted. Disabled/uninstalled collection retains state until resumed or explicitly removed.

## Development and regression checks

Development requires pnpm 10 and Bun 1.4. The shipped helper includes that runtime. SQLite, Temporal, URL, JSON and filesystem APIs are native; Markdown references use mdast, shell syntax uses shell-quote, and V4A edit application uses the official OpenAI Agents SDK. Conservative attribution checks remain around its fuzzy matching. Runtime/build source has an AST regression check prohibiting local regular expressions.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
bash scripts/package.sh v0.1.0-rc.9 dist
```

The Go implementation is frozen separately as a regression oracle. Checked-in Go-generated wire/hash fixtures and a populated legacy SQLite fixture test byte-compatible identities, hash chains and restart delivery without Go installed. Tests also cover account isolation, retries/splits, raw caps, plan handoff, symlink races, deadlines and installer refusal/cleanup.

The private native lab drives official clients through Driver/TMUX under an OS network/file gate and a fake loopback provider. It compares model payloads/replies, usage and durable file evidence. It never uses production inference, real credentials or normal-HOME plugin settings. Its frozen checker and failed/passing receipts stay outside this product repository. Linux CLI hooks, IDE/cloud sessions, concurrent native sessions, compaction and WebSockets need separate surface-specific evidence before broader support claims.

Use `pnpm exec bun scripts/benchmark.ts --baseline /absolute/path/to/frozen-go --candidate "$PWD/bin/kimchi-adapters" --out /absolute/path/to/new-results` for the executable comparison. Report medians/p95, sample counts, memory and archive bytes independently; TypeScript alone does not imply smaller or faster. Native syscall bridging uses Bun FFI for rooted openat and the existing flock; Bun documents FFI as experimental, so platform smoke tests and pinned-runtime upgrades are required.
