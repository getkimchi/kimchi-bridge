---
name: kimchi-login
description: Sign in to Kimchi (CAST AI SSO) for this user and route Codex model requests through the Kimchi gateway. Use when the user asks to sign in to Kimchi, connect their Kimchi account, or route their requests through Kimchi.
---

# Kimchi sign-in

Run the Kimchi sign-in for this user:

```bash
kimchi-adapters login
```

Run it with a shell timeout of at least 600000 milliseconds. The command opens the user's browser and waits, up to five minutes, for the sign-in to complete. Do not run it in the background; it prints its own progress. If the user named an organization to use, add `--org <id>`.

When it finishes:

- **Success**: report the organization name it printed, and tell the user that Codex (and Claude Code, where the plugin is installed) now sends model requests through the Kimchi gateway, and that `kimchi-adapters gateway disable` reverts to the previous providers.
- **"multiple organizations"**: show the listed organization ids and names, ask the user which one to use, then re-run the command with `--org <id>` added.
- **Timeout or cancellation**: tell the user to finish the browser sign-in and try again.
- **Port 8765 in use**: another CAST AI sign-in is in progress; tell the user to finish or cancel it and retry.

The command prints no tokens or secrets. Do not read, print, or store any credential files while doing this.
