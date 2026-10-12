<p align="center">
  <img src="assets/brand/logo.png" alt="MacleanFy" width="520">
</p>

<p align="center">
  An open source Mac cleaner with a graphical interface.<br>
  <a href="https://macleanfy.com/en">macleanfy.com</a> · <a href="README.md">Português</a>
</p>

![MacleanFy overview](docs/screenshots/visao-geral.png)

## Based on mac-cleaner-cli

MacleanFy is based on **[guhcostan/mac-cleaner-cli](https://github.com/guhcostan/mac-cleaner-cli)**,
a terminal tool released under the MIT license. The scanners and safety rules come from it;
MacleanFy adds the graphical interface. [NOTICE.md](NOTICE.md) lists what was copied, what
changed and what is new.

If you prefer the terminal, use the original project.

## Install

Download the installer from the [latest release](https://github.com/Meigston/MacleanFy/releases/latest):

| Your Mac | Installer |
| --- | --- |
| Apple Silicon (M1 or later) | **[MacleanFy-arm64.dmg](https://github.com/Meigston/MacleanFy/releases/latest/download/MacleanFy-arm64.dmg)** |
| Intel | **[MacleanFy-x64.dmg](https://github.com/Meigston/MacleanFy/releases/latest/download/MacleanFy-x64.dmg)** |

Not sure? Open the Apple menu → **About This Mac**: a "Chip" line means Apple Silicon, a
"Processor" line means Intel. Requires macOS 12 or later.

1. Open the `.dmg` and drag MacleanFy to the Applications folder.
2. Open MacleanFy. The installer is signed and notarized by Apple: the first time, macOS
   only asks you to confirm opening an app downloaded from the internet.
3. For the scan to see the Trash, Mail and Safari, grant [Full Disk Access](#full-disk-access).

The release page lists the SHA-256 of each installer. To check your download:

```bash
shasum -a 256 ~/Downloads/MacleanFy-arm64.dmg
```

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

**Updates.** The app checks the project's releases on GitHub when it opens and once a day,
without sending any of your data. When there is a new version it tells you; it only
downloads if you ask, and installs on restart. You can check right away under *About &
settings*.

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

## Running from source

Requirements: macOS 12 or later, Node 22 and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Meigston/MacleanFy.git
cd MacleanFy
pnpm install
pnpm dev
```

### Building the installer

```bash
pnpm dist
```

For each architecture, `dist/` gets the installer people download and the package the
installed app uses to update itself:

| File | For |
| --- | --- |
| `MacleanFy-arm64.dmg` and `MacleanFy-arm64.zip` | Apple Silicon Macs (M1 or later) |
| `MacleanFy-x64.dmg` and `MacleanFy-x64.zip` | Intel Macs |
| `latest-mac.yml` | tells the app which version is new and the SHA-512 of each `.zip` |

Without a certificate the build is ad-hoc signed: it opens right away on the Mac that
compiled it, and on any other Mac macOS blocks the first launch. To allow it, open **System
Settings → Privacy & Security** and click **Open Anyway**, or run
`xattr -dr com.apple.quarantine /Applications/MacleanFy.app`. The published installers are
signed and notarized.

### Signing and notarizing

To distribute it, the installer needs a *Developer ID Application* certificate and Apple
notarization. With the certificate in your Keychain, `pnpm dist` signs and notarizes both
the app and the `.dmg`:

```bash
export CSC_NAME="Your Name (TEAMID)"
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
pnpm dist
```

Instead of the API key you can use a `notarytool` profile (`APPLE_KEYCHAIN_PROFILE`) or
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. None of these credentials
belong in the repository.

### Publishing a version

The installed app updates itself from the GitHub releases, so a version only reaches people
who already use MacleanFy if the release carries the `.zip` files and `latest-mac.yml`.
After bumping the version in `package.json` and running the signed `pnpm dist`:

```bash
git tag v0.0.0 && git push origin v0.0.0
gh release create v0.0.0 --verify-tag dist/MacleanFy-*.dmg dist/MacleanFy-*.zip \
  dist/MacleanFy-*.zip.blockmap dist/latest-mac.yml
```

An update is only accepted with the same *Developer ID* signature as the installed app: an
ad-hoc build, or one signed with another certificate, is refused by macOS.

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
site/         the macleanfy.com page, static and dependency-free (`pnpm site:build`)
```

The interface ships in Portuguese (Brazil) and English, following the system language.

## Support the project

MacleanFy is free and open source. If it helped you, a contribution keeps the project going.
In the app, the same options are on the **Support** screen.

### 🌎 Stripe — outside Brazil

**[Contribute through Stripe](https://donate.stripe.com/cNidR81zYdGPfZngEVgUM00)**: you choose the amount and pay in US dollars by card,
Apple Pay or Google Pay.

### 🇧🇷 Pix — Brazil only

To Meigston da Silva Ramos. Open your bank app, choose to pay with Pix and point the camera at
one of the QR codes, or paste a code under *Pix copia e cola*.

| R$ 10.00 | Another amount |
| :---: | :---: |
| <img src="assets/support/pix-qr-fixed.svg" width="200" alt="Pix QR code for R$ 10.00"> | <img src="assets/support/pix-qr-open.svg" width="200" alt="Pix QR code for any amount"> |

Pix code for R$ 10.00:

```
00020126580014BR.GOV.BCB.PIX01363da966f1-bd8d-488e-89a9-faadb0e5b63a520400005303986540510.005802BR5923Meigston da Silva Ramos6009SAO PAULO62140510wgZQvZ2KYU6304BF83
```

Pix code for another amount, which you choose in your bank app:

```
00020126580014BR.GOV.BCB.PIX01363da966f1-bd8d-488e-89a9-faadb0e5b63a5204000053039865802BR5923Meigston da Silva Ramos6009SAO PAULO62070503***63042E26
```

## License

[MIT](LICENSE), © 2026 [Meigston Ramos](https://www.linkedin.com/in/meigston/). Parts of the
code come from mac-cleaner-cli, also MIT — see [NOTICE.md](NOTICE.md).

MacleanFy deletes files. It is provided without warranty: review the list before confirming
and keep a backup of what matters.
