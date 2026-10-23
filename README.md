# Kimchi work adapters

Two independent plugins for the official Claude Code and Codex CLIs. Each bundles a recorder, durable SQLite outbox and background uploader. Both share the same local work registry. Inference goes to the user's existing provider or gateway; normalized work records go directly to the Cast API.

This is a release candidate. Direct reporting requires the companion ai-optimizer API and console changes to be deployed with their generated RBAC policy. An older server leaves uploads pending. No production rollout is performed by the installer.

## Install

Requires access to this private repository, authenticated `gh`, and the official client(s) on PATH. macOS and Linux arm64/amd64 builds are provided; native compatibility is verified on macOS with Claude Code 2.1.309 and Codex CLI 0.164.0. Linux binaries must be treated as compiled support until native checks run there. Windows, IDE and cloud sessions are outside this release.

The main entry point is Kimchi's installer, which installs Kimchi and pulls the selected adapter release. The adapter option is in [Kimchi PR #1524](https://github.com/getkimchi/kimchi/pull/1524). Until that installer ships in a stable Kimchi release, use this pinned preview of the same script:

```sh
curl -fsSL https://raw.githubusercontent.com/getkimchi/kimchi/7fbbb81b7876d4734ad7d423fad8fc373aa47417/scripts/install.sh | bash -s -- --adapters both
```

Use `--adapters claude` or `--adapters codex` for one client; omitting the option installs Kimchi only. `KIMCHI_VERSION` and `KIMCHI_ADAPTERS_VERSION` pin the two release streams independently. Rerun the same command to update Kimchi and the selected adapters. Once the shared installer is released, the same options work with Kimchi's usual `releases/latest/download/install.sh` URL.

Kimchi's script downloads the private adapter bootstrap through authenticated `gh`; that bootstrap verifies archive SHA256 and paths and uses each client's native plugin manager. No Go or Node installation is needed. Start a new client session and accept its ordinary plugin trust prompt. Add `~/.local/bin` to PATH if needed, then run `kimchi-adapters status`. Finish active coding sessions before updating or removing a plugin. The adapter release's `install.sh` remains the internal provisioning helper and supports existing installations.

Configure reporting once, with JSON on stdin. Use a private file or a password manager's stdin output; keep credentials out of shell history and Git:

```json
{
  "apiUrl": "https://api.cast.ai",
  "organizationId": "YOUR-ORGANIZATION-UUID",
  "apiKey": "YOUR-USER-REPORTING-KEY"
}
```

Run `kimchi-adapters configure < /path/to/private/reporting.json`. A user SSO bearer token may be supplied as `accessToken` instead of `apiKey`. The existing `/v1/me` endpoint verifies the user. State is separated by reporting endpoint, organization and actor; a key rotation is verified again. Unassigned records captured before login stay local and are never silently uploaded as the new user. Service-account keys are rejected. The reporting user needs the new ingestion permission; Jira's one-use connection key is not a reporting credential.

## Controls and outputs

```sh
kimchi-adapters status                   # counts, gaps and pending uploads; no credentials
kimchi-adapters disable                  # stop capture and delivery; retain data
kimchi-adapters enable
kimchi-adapters flush                    # recover and deliver pending records
kimchi-adapters export jsonl > work.jsonl # or export csv
kimchi-adapters update both v0.1.0-rc.1   # independently: claude or codex
kimchi-adapters uninstall claude
```

Local JSONL/CSV contains normalized revisions, not calculated invoice amounts. CSV protects spreadsheet formula cells. Cast calculates API reference estimates using its existing model catalog and keeps the selected rates with each valuation. Optional `otlpUrl` (the full `/v1/logs` endpoint) and `otlpHeaders` in reporting configuration export normalized OTLP/HTTP JSON logs to a customer collector. Cast and OTLP have separate receipts and credentials. OTLP is at least once; consumers deduplicate by event ID and use the highest entity revision. Native enterprise exporters are never changed.

Default state is `~/.local/state/kimchi-adapters`; installed releases are under `~/.local/share/kimchi-adapters`. Both can be redirected for testing with `KIMCHI_ADAPTERS_HOME` and `KIMCHI_ADAPTERS_PREFIX`. Uninstall retains reporting credentials, ledger and release files, and disables collection after the last plugin is removed. It does not delete customer data.

## What is recorded

Native sessions stay pinned to the reporting account selected at first capture. Changing the global login does not relabel an older open session or upload its queue with the new user's credentials. The running collector continues processing older sessions and pre-login transcripts into their original local queues. Start a new session to record under the new account; select the original verified account to upload its pending records.

| Evidence | Capture and limits |
| --- | --- |
| Work and plans | Persisted session/turn/agent bindings; existing plan path plus content revision; quoted file references and shared Git worktrees. Ambiguous plan ownership is preserved. Ordinary session continuation is inferred. |
| Requests and cache | Native transcript IDs/counters, Claude request telemetry when exposed, and supplementary mod step counters. Missing buckets stay unknown. Duplicate streams revise the same request. |
| Tools and files | Native tool IDs, names, outcomes and durations; synchronous preimages and verified native edit results; opaque file/revision IDs on upload. Concurrent or shell changes retain weaker attribution. |
| Git and PRs | Exact parent-to-child blob matches to newly observed commits, then authenticated read-only `gh`/`glab` commit-to-PR discovery. PR lifecycle and observed title/branch Jira keys feed existing reporting. Automatic whole-work attribution is inferred. |
| Coverage | Source versions, missing identities/counters, unknown pricing, capture bounds and delivery errors. Status exposes diagnostics; totals must be assessed with coverage. |

Put portable plans in `plans/` or `.plans/` so verified native writes register them. Claude's exposed `ExitPlanMode` file path is also observed. Referencing the actual registered revision from another client retains its work ID. A displayed plan without a real file is not a saved plan. New prompts retain the session's work by default. Start a separate item in the same session with an ordinary prompt beginning `New work: title` on its first line; that explicit title and its Jira keys become metadata. Remaining prompt text stays local. Task switching without a recognizable boundary remains inferred.

Native plugins cannot see hidden gateway retries, model routing or negotiated invoices. Codex does not expose a reliable proxy response-header identity in the tested surfaces, and auxiliary requests can be absent from its transcript. Claude mod steps expose counters without a cross-source response ID, so those counters are supplementary rather than another charge. Subscription dollars and consumed credits remain unknown unless independently exposed. A request's known subtotal is not a complete work cost. Provider tools can incur charges absent from token counters.

## Delivery, accounting and retention

Only explicit work titles and PR metadata can contain human text on upload. The rest of a prompt stays local.

Uploads are record deltas, normally at most 100 events and about 1 MiB. A 413 response splits durable batches into smaller parts, retaining event IDs, revisions and order. A lost ACK replays the same part; unchanged observations produce no new upload. One record that cannot fit remains pending with a diagnostic. No work item must fit in one request, and records are never sent as partial legacy inventories.

The API uses the existing generated gateway, pricing catalog and PR/Jira bill union. Detailed normalized events are batch-inserted directly into ClickHouse without Pub/Sub. PostgreSQL retains financial quotes, effective attribution and compact revision/receipt guards. The server ACK follows both writes; a failed ClickHouse write is repaired by durable client replay. This is not a cross-database atomic transaction. Exact owned proxy aliases use verified billing and suppress an additional estimate. API estimates and verified charges remain separate; unmatched identities do not imply zero or prove that two observations are different bills.

Prompts, source text, plan text, paths, file hashes, tool arguments/results and credentials are excluded from upload. Local before/after file contents are private evidence: seven days, at most 256 MiB, with 4 MiB per file and bounded capture work. Tool/preimage detail expires after seven days. Normalized records have a 1 GiB hard capacity; pending accounting is not age-deleted. At capacity capture fails open and status shows a gap; export and investigate before removing state. Compact plan/identity metadata remains local. Server detailed logs expire after 90 days from first receipt; financial quotes and replay guards follow accounting retention and organization deletion policy.

## Run the isolated probe

Retention is enforced while the collector runs and at its next start, including expired detail from previous accounts and pre-login state. Disabling or uninstalling retains local files until collection resumes or the user removes them. The normalized capacity is 1 GiB **per account**. Financial server history has no automatic time expiry in this release; organization cleanup must include the adapter's org-scoped tables alongside existing PR accounting.

Requirements: macOS with `sandbox-exec`, Go 1.26.2, and the official `claude` and `codex` executables on PATH. Tested native versions: Claude Code 2.1.309 and Codex CLI 0.164.0. Linux execution deliberately fails closed until an equivalent isolation boundary is implemented.

From the repository root:

```sh
go test -race ./...
go vet ./...
go build -o "$HOME/.local/state/kimchi-adapters/probe-bin/capture-probe" ./cmd/capture-probe
"$HOME/.local/state/kimchi-adapters/probe-bin/capture-probe" \
  --root "$HOME/.local/state/kimchi-adapters/probes/run-$(date +%s)" \
  --fixtures "$PWD/probes" --harness both --paired
```

The scratch directory must be new, absolute, and outside the repository. Choose `--harness claude` or `--harness codex` to run one pair. Every selected harness runs once without capture and once with capture. The synthetic provider asks the official CLI to change `probe.txt` from `before` to `after`, then reply `done`.

## What the probe verifies

- An OS gate permits the loopback fixture endpoint and requires explicit denial of external networking and a private-file canary before native processes start. Disposable HOME/config paths and an environment allowlist prevent inheriting account credentials. No real provider inference is used.
- Claude loads a scratch plugin with native mod events. Codex installs a scratch local-marketplace plugin with command hooks. Native OTLP can be enabled only in the disposable fixture; `--native-telemetry=false` checks the defaults. Registration and activation evidence is retained.
- The fixture recorder fsyncs synthetic pre/post edit state before returning. Pass `--product /absolute/path/to/kimchi-adapters --fixtures "$PWD/plugins"` to test the bundled product instead. Assertions require matching tool identities, state and pre-before-post ordering.
- Provider request counts, normalized request payloads, and final replies are compared. Normalization removes scratch paths, known generated identity metadata and native chunk IDs—not prompts, tools, models, or actual tool output. Full native stdout and stderr remain available separately; final-reply equality does not mean byte-identical lifecycle output.
- Raw synthetic records stay in the private scratch directory. The probe does not upload to Cast or a remote collector. `.kimchi/docs/` is local-only and ignored by Git.

## Evidence and limits

Each run saves `report.json`, setup receipts, private native stdout/stderr, provider `wire/` records, `events/`, `otlp/`, and native scratch transcripts. Files are bounded and private. `retention.json` records a seven-day expiry target; automated deletion is **not** implemented. Keep these synthetic captures out of Git and remove expired run directories after review.

A passing basic probe covers SSE, one turn, serial tools, a synthetic API key and a fake model catalog. It does not establish full coverage under concurrency, cancellation, compaction or WebSockets. Codex traces and logs have been inspected: their usage and turn identities cannot reliably be joined at request level; transcript recovery remains the accounting source. Fake-provider wire identifiers are test ground truth, not an identity the direct-upload plugin may invent.

Native telemetry can contain tool arguments/output even with prompt logging disabled. The uploader exports only the typed allowlist, never native bodies. Usage from step, turn, transcript and telemetry overlaps; do not sum these streams. Subscription costs and rate-card estimates are not invoice evidence.

The probe never activates a plugin in the normal HOME or calls production inference. Use `--driver` for the real interactive clients controlled through Driver/TMUX. `--installer-package /absolute/path/to/archive.tar.gz` checks native install/status/reinstall/uninstall under the same OS gate.
