# activity-files

A Claude Code mod that adds a **Files** pane beside the chat showing what Claude is doing, as it does it:

- **Right now**: a card that says whether Claude is thinking, reading a file, editing one, running a command or has just committed, with the branch and whether anything is uncommitted.
- **Claude touched**: every file Claude read or changed in the current task, with a status pill (Reading, Opened, Editing, Edited, Committed).
- **All files**: a git-aware file tree. Changed folders and files are highlighted, and the file Claude is working on gets a small pulsing dot and a light that sweeps across its row.
- Search, plus buttons to refresh, collapse, show sizes, go up a folder, go back to the project and hide hidden files.

The pane opens when Claude starts working and closes a few seconds after it finishes. `/files` opens it by hand.

## Install

The repository is private, so you need access to it on GitHub, and your computer needs GitHub set up for git (an SSH key, or `gh auth login` and then `gh auth setup-git`).

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
