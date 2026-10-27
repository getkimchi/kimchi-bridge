# Kimchi PR-cost plugins

Plugins for the official Claude Code and Codex CLIs. They record the token usage of your coding sessions, link it to the pull requests that contain your changes and upload it to Cast AI with your Kimchi sign-in. The Kimchi console then shows what each pull request cost. Your inference provider and settings stay the same.

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

A session reports to the account Kimchi was signed in to when the session started. Sessions that start while Kimchi is signed out stay on your machine and are never uploaded.

### Check and control reporting

| Command | What it does |
| --- | --- |
| `kimchi-bridge status` | Shows whether Kimchi is signed in and verified, the local data folder, queued uploads and recording problems. |
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

A background sync uploads new records to the Cast AI API when a session starts, after each turn and every 30 seconds while Claude Code is open. Records that fail to upload stay queued for the next sync. Nothing runs while the clients are closed.

Uploads contain IDs, timestamps, token counts, model names, tool names and outcomes, commit IDs, repository names, pull request numbers, titles and links, `New work:` titles, and issue keys found in titles and branch names. They don't contain prompts, replies, code, file contents, file paths, or tool inputs and outputs.

Cast AI prices the usage and shows the cost of each pull request in the Kimchi console, under Reporting → PR costs.
