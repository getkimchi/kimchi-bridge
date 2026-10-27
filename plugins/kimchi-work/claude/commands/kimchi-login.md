---
description: Sign in to Kimchi (CAST AI SSO) and route model requests through the Kimchi gateway
argument-hint: [--org <organization id>]
allowed-tools: Bash(kimchi-adapters:*)
---

Run the Kimchi sign-in for this user:

```bash
kimchi-adapters login $ARGUMENTS
```

Use the Bash tool with a timeout of 600000 milliseconds. The command opens the user's browser and waits, up to five minutes, for the sign-in to complete. Do not run it in the background; it prints its own progress.

When it finishes:

- **Success**: report the organization name it printed, and tell the user that Claude Code and Codex now send their model requests through the Kimchi gateway, and that `kimchi-adapters gateway disable` reverts to the previous providers.
- **"multiple organizations"**: show the listed organization ids and names, ask the user which one to use, then re-run the same command with `--org <id>` added.
- **Timeout or cancellation**: tell the user to finish the browser sign-in and run `/kimchi-login` again.
- **Port 8765 in use**: another CAST AI sign-in is in progress; tell the user to finish or cancel it and retry.

The command prints no tokens or secrets. Do not read, print, or store any credential files while doing this.
