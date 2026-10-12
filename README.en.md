<p align="center">
  <img src="assets/brand/logo.png" alt="MacleanFy" width="520">
</p>

<p align="center">
  An open source Mac cleaner with a graphical interface.<br>
  <a href="README.md">Português</a>
</p>

![MacleanFy overview](docs/screenshots/visao-geral.png)

## Based on mac-cleaner-cli

MacleanFy is based on **[guhcostan/mac-cleaner-cli](https://github.com/guhcostan/mac-cleaner-cli)**,
a terminal tool released under the MIT license. The scanners and safety rules come from it;
MacleanFy adds the graphical interface. [NOTICE.md](NOTICE.md) lists what was copied, what
changed and what is new.

If you prefer the terminal, use the original project.

## What it does

**Overview.** Disk health, reclaimable space by group, what you have freed so far and
recommendations on what to clean first.

**Cleaning.** Sixteen categories in five groups. Each one shows its risk level, and you can
open a category to pick item by item.

| Group | Categories |
| --- | --- |
| System junk | app caches, logs, temporary files, language files, orphaned launch agents |
| Development | npm/Yarn/pnpm/pip/Gradle/Cargo/CocoaPods/Xcode caches, Homebrew, Docker, stale `node_modules` |
| Storage | Trash, old downloads, iOS backups, Mail attachments, duplicate files |
| Browsers | Chrome, Safari, Firefox and Arc caches |
| Large files | files over 500 MB in Downloads and Documents |

**Uninstaller.** Lists applications with the size of the app and of the files it left in
your Library, and moves everything to the Trash.

**Maintenance.** Flush the DNS cache and free purgeable space.

## Safety

A cleaner deletes files. These are the guards:

- **Scanning only reads.** Nothing is deleted before you review the list and confirm.
- **Only safe categories are pre-selected.** Moderate and risky ones wait for your choice.
  So does Docker, because cleaning it runs `docker system prune -af`.
- **Risky items ask for an extra confirmation**, and the dialog shows the warning for each.
- **You can do a dry run.** It walks through everything without deleting.
- **System paths are off limits.** `/System`, `/usr`, `/bin`, `/etc` and the like are
  refused on removal and never even listed.
- **Temporary files in use are left alone.** Only what has been idle for over a day is
  offered; sockets and folders with recent activity never are.
- **The interface does not dictate paths.** The process that deletes only accepts what the
  last scan returned. The interface runs isolated, with no access to Node or the disk.
- **Uninstalling is reversible.** Apps go to the Trash.

Cleaning a category **is permanent**: files do not go through the Trash.

## Running it

Requirements: macOS 12 or later, Node 22 and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Meigston/MacleanFy.git
cd MacleanFy
pnpm install
pnpm dev
```

To build the application:

```bash
pnpm dist      # creates dist/MacleanFy-<version>.dmg
```

The build is ad-hoc signed, which is enough to run what you compiled yourself. There is no
signed and notarized installer to download yet.

### Full Disk Access

Without it macOS hides the Trash, Mail and Safari, and the scan shows those categories as
empty. Grant it in **System Settings → Privacy & Security → Full Disk Access** — the app has
a shortcut under *About & settings*. In development the permission applies to the terminal
you ran `pnpm dev` from.

## Project layout

```
src/
  core/       engine: scanners, safety rules and uninstall (derived from mac-cleaner-cli)
  main/       Electron main process: scanning, cleaning, history and system
  preload/    the only bridge between the interface and the main process
  shared/     the contract of that bridge
  renderer/   the React interface
```

The interface ships in Portuguese (Brazil) and English, following the system language.

## License

[MIT](LICENSE). Parts of the code come from mac-cleaner-cli, also MIT — see
[NOTICE.md](NOTICE.md).

MacleanFy deletes files. It is provided without warranty: review the list before confirming
and keep a backup of what matters.
