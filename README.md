# Kimchi bridge

Kimchi plugins for other coding harnesses, run by the `kimchi-bridge` command. The `kimchi-work` plugin works with the official Claude Code and Codex CLIs. It records the token usage of your coding sessions, links it to the pull requests that contain your changes and uploads it to your Kimchi account. The Kimchi console then shows what each pull request cost. Your inference provider and settings stay the same.

## Install

### Requirements

- Kimchi, installed with its install script. The plugins run on Kimchi's runtime.
- Claude Code (`claude`), Codex (`codex`) or both, in a version that supports plugins.
- GitHub CLI (`gh`) signed in for repositories on GitHub, GitLab CLI (`glab`) signed in for repositories on GitLab.
- For a self-hosted GitHub or GitLab, `GH_HOST` or `GITLAB_HOST` set to its host name.
- macOS or Linux (glibc), on arm64 or x86-64.

### Install with Kimchi

Kimchi's installer installs the Kimchi CLI and adds the plugins to each official client it finds:

```sh
curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash
```

Start a new Claude Code or Codex session. Codex first shows "Hooks need review"; choose to trust them. If you install Claude Code or Codex later, run Kimchi's installer again.

### Update

Kimchi's releases include the plugins, and Kimchi updates the plugins it added when it updates itself. Open sessions switch to the new code with their next hook. Only an update that changes the plugins' hooks registers them again: open Codex sessions then stop recording until you start a new one, and Codex asks you to trust the new hooks.

### Uninstall

1. Finish your active Claude Code and Codex sessions.
2. Upload anything still queued:

   ```sh
   kimchi-bridge flush
   ```

3. Remove the plugins. Choose `claude`, `codex` or `both`:

   ```sh
   kimchi-bridge uninstall both
   ```

Your local records and the plugin files stay in `~/.local/state/kimchi-bridge` and `~/.local/share/kimchi-bridge` until you delete them. Kimchi's updates leave removed plugins removed; running Kimchi's installer adds them again.

## Use

### Sign in

There is nothing to set up: the plugins report with your Kimchi sign-in. They use the API key in `KIMCHI_API_KEY` or `~/.config/kimchi/config.json`, or else your Kimchi SSO login, in Kimchi's region. To sign in or switch accounts, run `kimchi`.

The plugins also have their own sign-in, a CAST AI single sign-on (OAuth, with automatic token refresh) that works without the Kimchi CLI:

```sh
kimchi-bridge login
```

This opens a browser sign-in, asks for your organization when the account has several, and saves the credential under `~/.local/state/kimchi-bridge`. Inside Claude Code run `/kimchi-login`, in Codex ask it to use the `kimchi-login` skill. When the Kimchi CLI is signed in, `kimchi-bridge login --from-kimchi` reuses its credential without another browser round-trip.

A successful sign-in also routes Claude Code and Codex model requests through the Kimchi LLM gateway (`llm.kimchi.dev`): it writes `~/.claude/settings.json` and `~/.codex/config.toml`, and runs a small local proxy that keeps OAuth tokens fresh and adds your organization header. API-key sign-ins connect direct, with the key embedded and no proxy. Revert anytime:

```sh
kimchi-bridge gateway disable
```

A session reports to the account the sign-in verified when the session started. Sessions that start while signed out stay on your machine and are never uploaded.

### Check and control reporting

| Command | What it does |
| --- | --- |
| `kimchi-bridge login` | CAST AI SSO sign-in (OAuth); enables the gateway automatically. |
| `kimchi-bridge login --from-kimchi` | Reuses the Kimchi CLI's saved sign-in. |
| `kimchi-bridge login --region eu` | Signs in to the EU region. |
| `kimchi-bridge login --org <id>` | Picks the organization when the account has several. |
| `kimchi-bridge login --no-browser` | Prints the sign-in link instead of opening it. |
| `kimchi-bridge login --reporting-only` | Signs in without switching inference to the gateway. |
| `kimchi-bridge login status` | Prints the sign-in state as JSON (used by the in-client sign-in commands). |
| `kimchi-bridge gateway enable` | Routes Claude Code and Codex through the Kimchi gateway in the mode matching your sign-in (OAuth via the local proxy; API keys direct). |
| `kimchi-bridge gateway disable` | Restores the previous provider settings and stops the proxy. |
| `kimchi-bridge gateway status` | Shows the gateway state as JSON. |
| `kimchi-bridge status` | Shows whether the sign-in is verified, the gateway state, the local data folder, queued uploads and recording problems. |
| `kimchi-bridge flush` | Uploads all queued records now. |
| `kimchi-bridge disable` | Pauses recording and background uploads. Local records are kept. |
| `kimchi-bridge enable` | Resumes recording and uploads. |
| `kimchi-bridge export jsonl` | Prints all local records as JSON Lines. Use `export csv` for CSV. |
| `kimchi-bridge version` | Prints the installed version. |

### Start new work

All prompts in a session count as one piece of work. To start a new one, begin a prompt with `New work:` and a title:

```text
New work: Add retries to uploads
```

The title is uploaded, so keep private details out of it.

To continue the same work in another session, or in the other client, have the agent save its plan as a Markdown file in `plans/` or `.plans/`. Then mention the file's path in your prompt. This works while the file matches a version the agent saved.

## How it works

Claude Code and Codex hooks run the plugins' code on Kimchi's own runtime (`BUN_BE_BUN=1 kimchi`), without loading the project's `.env` or `bunfig.toml`. The code records the token usage of each model request, read from the client's transcripts, and each tool call with its outcome. It also keeps copies of the files each tool works on, from before and after the call. It then matches file changes to your Git commits and asks `gh` or `glab` which pull requests contain those commits. It doesn't change prompts or replies, and if recording fails, your session carries on.

Records are saved in SQLite databases under `~/.local/state/kimchi-bridge`, one for each account. The plugins keep no key: they read Kimchi's sign-in each time they upload. File copies never leave your machine. While recording is on, copies older than seven days are deleted.

A background sync uploads new records to the Kimchi API when a session starts, after each turn and every 30 seconds while Claude Code is open. Records that fail to upload stay queued for the next sync. Nothing runs while the clients are closed.

Uploads contain IDs, timestamps, token counts, model names, tool names and outcomes, commit IDs, repository names, pull request numbers, titles and links, `New work:` titles, and issue keys found in titles and branch names. They don't contain prompts, replies, code, file contents, file paths, or tool inputs and outputs.

Kimchi prices the usage and shows the cost of each pull request in the Kimchi console, under Reporting → PR costs.

### Example records

`kimchi-bridge export jsonl` prints your records one per line, as they are uploaded. The examples below come from a Claude Code session that started new work, edited a file, committed it and opened a pull request. The repository and values are made up, and IDs are shortened.

Every record has the same envelope:

```json
{
  "id": "0f6c2a1e-…",
  "entityId": "a9a247a0-…",
  "revision": "1",
  "source": "claude-code",
  "sourceVersion": "2.1.311",
  "deviceId": "233dad79-…",
  "observeTime": "2026-10-27T10:16:00.277Z",
  "workId": "30918956-…",
  "sessionId": "68765adc-…",
  "turnId": "b3cd3558-…"
}
```

It adds one field that says what it records. The prompt `New work: Add retries to uploads` records:

```json
"work": { "title": "Add retries to uploads", "reason": "explicit_new_work", "quality": "confirmed" }
```

Each model request records its token counts. Kimchi prices them from the model, provider, service tier and region:

```json
"usage": {
  "channel": "transcript",
  "requestId": "req_011C…",
  "responseId": "msg_01Hk…",
  "schema": "anthropic-messages-v1",
  "counterScope": "request",
  "observedRoute": "provider-api",
  "reportedModel": "claude-opus-5-5",
  "actualModel": "claude-opus-5-5",
  "provider": "anthropic",
  "serviceTier": "standard",
  "region": "global",
  "billingBasis": "unknown",
  "correlation": "native_transcript_prompt",
  "raw": {
    "inputTokens": "1840",
    "outputTokens": "412",
    "cacheReadTokens": "35210",
    "cacheWriteTokens": "2048",
    "cacheWrites": [{ "ttlSeconds": 300, "tokens": "2048" }]
  },
  "attemptsComplete": false,
  "stopReason": "tool_use"
}
```

A Codex request has `"provider": "openai"`, `"schema": "openai-responses-v1"`, `reasoningTokens` among the counts, and `"serviceTier": "default"`, or `"priority"` in Fast mode. Codex's transcript has no request ID or region.

Once the commit is in a pull request, `gh` or `glab` supplies the pull request:

```json
"repository": { "provider": "github", "host": "github.com", "id": "731942", "name": "lumbrook/checkout" },
"pullRequest": {
  "id": "2290415873",
  "number": 128,
  "uri": "https://github.com/lumbrook/checkout/pull/128",
  "state": "merged",
  "createTime": "2026-10-27T11:02:10Z",
  "closeTime": "2026-10-27T15:40:02Z",
  "mergeTime": "2026-10-27T15:40:02Z",
  "mergeCommitId": "5be0e1c4…",
  "title": "PAY-412: Add retries to uploads",
  "issueKeys": [{ "key": "PAY-412", "source": "title" }]
}
```

Other records connect the request to the commit, or count what couldn't be measured:

| Record | Example |
| --- | --- |
| Tool call | `"tool": { "callId": "toolu_01…", "name": "Edit", "requestEntityId": "cab71c15-…", "category": "edit", "outcome": "completed" }` |
| File change | `"file": { "fileId": "7d1e…", "toolCallId": "toolu_01…", "beforeRevision": "41a8…", "afterRevision": "c09f…", "operation": "modified", "quality": "tool_observed" }` |
| Commit | `"commit": { "id": "9f3b2c7d…", "parents": ["e41d0a6b…"], "quality": "confirmed" }` |
| Link | `"link": { "fromKind": "work", "fromId": "30918956-…", "toKind": "commit", "toId": "9f3b2c7d…", "quality": "confirmed", "reason": "exact_blob_transition" }` |
| Coverage | `"coverage": { "code": "native_auxiliary_usage_coverage_unknown", "count": "1" }` counts what the client didn't expose, so a report can show it is incomplete. |

`fileId`, `beforeRevision` and `afterRevision` are IDs. The file's path and contents stay on your machine.

## Repository layout

Shared code lives at the top of `src/`: the `kimchi-bridge` command in `cli.ts`, Kimchi's sign-in in `kimchi.ts`, local settings and session binding in `settings.ts`, and platform helpers in `platform.ts`. A plugin's code lives in its own folder under `src/`, and its Claude Code and Codex files in `plugins/<plugin>/claude/` and `plugins/<plugin>/codex/`. The `kimchi-work` plugin uses `src/work/` and `plugins/kimchi-work/`.
