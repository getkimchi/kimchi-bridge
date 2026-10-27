# Kimchi PR-cost plugins

Plugins for the official Claude Code and Codex CLIs. They record the token usage of your coding sessions, link it to the pull requests that contain your changes and upload it to Cast AI. The Kimchi console then shows what each pull request cost. Your inference provider and settings stay the same.

## Install

### Requirements

- Claude Code (`claude`), Codex (`codex`) or both, in a version that supports plugins.
- GitHub CLI (`gh`), signed in with access to `getkimchi/kimchi-adapters`.
- GitLab CLI (`glab`), signed in, if your repositories are on GitLab.
- For a self-hosted GitHub or GitLab, `GH_HOST` or `GITLAB_HOST` set to its host name.
- macOS or Linux (glibc), on arm64 or x86-64.

### Install together with the Kimchi CLI

Kimchi's installer installs or updates the Kimchi CLI and adds the plugins. Choose `claude`, `codex` or `both`:

```sh
curl -fsSL https://raw.githubusercontent.com/getkimchi/kimchi/7fbbb81b7876d4734ad7d423fad8fc373aa47417/scripts/install.sh | bash -s -- --adapters both
```

To pin versions, set `KIMCHI_ADAPTERS_VERSION` for the plugins and `KIMCHI_VERSION` for the Kimchi CLI.

### Install the plugins only

1. Clone this repository:

   ```sh
   gh repo clone getkimchi/kimchi-adapters
   cd kimchi-adapters
   ```

2. Run the installer. Choose `claude`, `codex` or `both`:

   ```sh
   bash install.sh install both
   ```

The installer downloads the newest release with `gh`, verifies its checksum and adds the plugins through each client's plugin manager. To install a specific release, add its tag as a third argument.

### After installing

Both installers add the `kimchi-adapters` command to `~/.local/bin` and set up reporting sign-in (see [Sign in](#sign-in)). Start a new Claude Code or Codex session and accept the plugin trust prompt.

### Update

Finish your active Claude Code and Codex sessions. Then run the update with the same choice you installed (`claude`, `codex` or `both`):

```sh
kimchi-adapters update both
```

This installs the newest release, or the tag you add as a third argument, and removes the old version. Your sign-in is kept.

### Uninstall

1. Finish your active Claude Code and Codex sessions.
2. Upload anything still queued:

   ```sh
   kimchi-adapters flush
   ```

3. Remove the plugins. Choose `claude`, `codex` or `both`:

   ```sh
   kimchi-adapters uninstall both
   ```

Your sign-in, local records and downloaded releases stay in `~/.local/state/kimchi-adapters` and `~/.local/share/kimchi-adapters` until you delete them.

## Use

### Sign in

The installer keeps an existing reporting sign-in. Otherwise it uses your Kimchi API key from `KIMCHI_API_KEY` or `~/.config/kimchi/config.json`. If there is no key, it opens a browser sign-in, or prints the command to run when it isn't running in a terminal.

To sign in again or switch accounts:

```sh
kimchi-adapters login
```

This opens the Kimchi console in your browser, where you create an API key. The key is verified and saved for reporting only. The Kimchi CLI's sign-in and your inference settings don't change. The key must belong to a Kimchi user; service-account keys are rejected.

A session reports to the account that was signed in when the session started. Sessions that start before you sign in stay on your machine and are never uploaded.

| Command | What it does |
| --- | --- |
| `kimchi-adapters login --from-kimchi` | Uses your Kimchi API key from `KIMCHI_API_KEY` or `~/.config/kimchi/config.json` instead of the browser. |
| `kimchi-adapters login --region eu` | Signs in to the EU region. |
| `kimchi-adapters login https://your-console.example` | Signs in to a self-hosted console. |
| `kimchi-adapters login --no-browser` | Prints the sign-in link instead of opening it. |

To sign in with a key file instead, save the API URL and key in a private JSON file and pass it to `configure`. Use `https://api.eu.cast.ai` for the EU region. If `KIMCHI_API_KEY` is set, it replaces the key in the file.

```json
{
  "apiUrl": "https://api.cast.ai",
  "apiKey": "YOUR-KIMCHI-API-KEY"
}
```

```sh
kimchi-adapters configure < /path/to/private/reporting.json
```

### Check and control reporting

| Command | What it does |
| --- | --- |
| `kimchi-adapters status` | Shows the sign-in state, the local data folder, queued uploads and recording problems. |
| `kimchi-adapters flush` | Uploads all queued records now. |
| `kimchi-adapters disable` | Pauses recording and background uploads. Local records are kept. |
| `kimchi-adapters enable` | Resumes recording and uploads. |
| `kimchi-adapters export jsonl` | Prints all local records as JSON Lines. Use `export csv` for CSV. |
| `kimchi-adapters version` | Prints the installed version. |

### Start new work

All prompts in a session count as one piece of work. To start a new one, begin a prompt with `New work:` and a title:

```text
New work: Add retries to uploads
```

The title is uploaded, so keep private details out of it.

To continue the same work in another session, or in the other client, have the agent save its plan as a Markdown file in `plans/` or `.plans/`. Then mention the file's path in your prompt. This works while the file matches a version the agent saved.

## How it works

The plugins run the bundled `kimchi-adapters` program from Claude Code and Codex hooks. It records the token usage of each model request, read from the client's transcripts, and each tool call with its outcome. It also keeps copies of the files each tool works on, from before and after the call. It then matches file changes to your Git commits and asks `gh` or `glab` which pull requests contain those commits. It doesn't change prompts or replies, and if recording fails, your session carries on.

Records are saved in SQLite databases under `~/.local/state/kimchi-adapters`, one for each account. Your API key is in `config.json` in the same folder, readable only by you. File copies never leave your machine. While recording is on, copies older than seven days are deleted.

A background sync uploads new records to the Cast AI API when a session starts, after each turn and every 30 seconds while Claude Code is open. Records that fail to upload stay queued for the next sync. Nothing runs while the clients are closed.

Uploads contain IDs, timestamps, token counts, model names, tool names and outcomes, commit IDs, repository names, pull request numbers, titles and links, `New work:` titles, and issue keys found in titles and branch names. They don't contain prompts, replies, code, file contents, file paths, or tool inputs and outputs.

Cast AI prices the usage and shows the cost of each pull request in the Kimchi console, under Reporting → PR costs.
