# activity-files

A Claude Code mod that adds a **Files** pane beside the chat showing what Claude is doing, as it does it:

- **Right now**: a card that says whether Claude is thinking, reading a file, editing one, running a command or has just committed, with the branch and whether anything is uncommitted.
- **Claude touched**: every file Claude read or changed in the current task, with a status pill (Reading, Opened, Editing, Edited, Committed).
- **All files**: a git-aware file tree. Changed folders and files are highlighted, and the file Claude is working on gets a small pulsing dot and a light that sweeps across its row.
- A search box; small icons beside "All files" to refresh, collapse every folder, go up a folder and go back to the project; and a gear at the top for the settings.

The pane opens when Claude starts working and closes a few seconds after it finishes. `/files` opens it by hand.

## Settings

Press the gear icon at the top of the pane (again to go back), or run `/files settings`. Settings are saved and apply to every session:

- **Open when Claude starts**: on or off.
- **Close after Claude finishes**: 2, 4, 8 or 15 seconds, or never.
- **Animations**: the pulsing dot, the light sweeping across the active row and the breathing status icon.
- **Clear the touched list each task**: start "Claude touched" empty for every new request.
- **Hidden files**: show or hide files and folders starting with a dot.
- **Right column**: show each file's last-modified time or its size.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install activity-files --marketplace voidmazejr/activity-files
```

Or from a shell:

```bash
claude plugin install activity-files --marketplace voidmazejr/activity-files
```

Answer `y` to add the marketplace, then press Enter for the user scope.

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `voidmazejr/activity-files`, then **Add plugin**.
