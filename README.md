# Allume Inbox for Obsidian

Capture anything on your phone or Mac with [Allume](https://allume.com) (formerly Muse), and have it show up in your Obsidian vault a few minutes later: text, links, photos, PDFs and other files.

> **Unofficial.** This plugin is not made by or affiliated with Allume. It uses the MCP server built into Allume for Mac.

```
iPhone / iPad / Mac ──► Allume inbox board ──► Allume for Mac
                                                  │  MCP (local, on your Mac)
                                                  ▼
                               Obsidian ── Allume Inbox plugin
                                  ├─ one note per capture, or
                                  └─ a list in today's daily note
                                     + attachments in your attachment folder
```

No AI model is involved and nothing leaves your Mac: the plugin talks to Allume's local helper (`allume-cli mcp`) directly.

## Requirements

- macOS, with Allume for Mac **v4.0 or later**
- Obsidian **desktop** 1.5.7 or later (the plugin doesn't run on mobile)
- Allume running while you sync. The plugin can launch it in the background for you.

## Set up

1. **Turn on Allume's MCP server.** In Allume, open **Preferences → MCP** and switch it on. Choose **read-write** if you want synced cards moved out of your inbox. **Read-only** works too, but then cards stay where they are.
2. **Install the plugin.**
   - From Obsidian: *Settings → Community plugins → Browse*, search for **Allume Inbox**. (Pending review; until it's listed, use BRAT below.)
   - With [BRAT](https://github.com/TfTHacker/obsidian42-brat): *Add beta plugin* → `nicholasren/obsidian-allume-inbox`.
   - Or manually: download `main.js`, `manifest.json` and `styles.css` from the latest release into `<your vault>/.obsidian/plugins/allume-inbox/`, then enable **Allume Inbox** in *Settings → Community plugins*.
3. **Connect.** In *Settings → Allume Inbox*, click **Test**. If the helper isn't found, click **Detect**, or paste the path shown in Allume → Preferences → MCP.
4. **Pick what to sync.** By default the plugin reads Allume's built-in **Inbox** (the one in Allume's sidebar, where quick captures from your phone land), in every workspace. Set *Workspace* to sync just one. Or set *Source* to **A board** and type a board's name.
5. **Choose where captures land** (see below), then run **Allume Inbox: Preview next sync** from the command palette to check the result before anything is written.
6. Run **Allume Inbox: Sync now**, or wait. By default the plugin syncs when Obsidian starts and every 5 minutes after that.

## Where captures land

**One note per capture** (default): each card becomes a note in a folder (default `Inbox/`), named after its capture time and first line:

```markdown
---
source: allume
allume_id: "A1B2C3"
captured: 2026-11-14T10:32
url: "https://example.com/article"
---
[Article title](https://example.com/article)
```

**Today's daily note**: each card becomes a list item at the end of a section in today's daily note (default heading `## Captured`). The plugin uses your Daily notes folder and date format unless you override them. If the heading is missing, it's added at the end of the note. Nothing else in the note is changed.

```markdown
## Captured
- Idea: ask the team about on-call rotas %%allume:A1B2C3%%
- [Allume CLI](https://allume.com/cli-setup) %%allume:D4E5F6%%
- ![[allume-2026-11-14-G7H8I9J0-whiteboard.jpg]] %%allume:G7H8I9J0%%
```

The `%%allume:…%%` comment doesn't show in reading view. It records which card a line came from and stops it being added twice.

Images are embedded. Other files (PDFs, video, audio) are linked. All files are saved to your attachment folder (*Settings → Files and links*), named `allume-<date>-<card id>-<original name>`.

## What happens in Allume

| After sync | What it does | Needs |
|---|---|---|
| **Keep it** (default) | Leaves cards where they are. The plugin remembers which ones it already synced. | MCP on (read-only or read-write) |
| **Remove it (recoverable)** | Soft-deletes each card once it's safely in your vault, so your Inbox empties. Allume can restore it. | MCP in read-write mode |
| **Move it to a board** | Moves each card out of Allume's built-in Inbox onto a board you name, such as "In Obsidian", in the same workspace. | MCP in read-write mode; built-in Inbox only (Allume can't move cards between ordinary boards) |

A card is only removed or moved after it has been written to your vault. Switching from *Keep* to *Remove* also cleans up cards that earlier syncs already imported.

## Commands

| Command | Does |
|---|---|
| Sync now | Pulls new cards immediately. Also on the ribbon icon and the status bar. |
| Preview next sync | Shows exactly what would be written, without writing anything. |
| Choose inbox board | Searches your Allume boards (for Source: A board). |
| Show raw Allume responses | Shows what Allume's MCP tools returned, for bug reports. Copy it into an issue. |

## Troubleshooting

| You see | Do this |
|---|---|
| *Allume helper not found* | Click **Detect** in settings, or copy the path from Allume → Preferences → MCP. Moving or updating Allume can change it. |
| *Allume isn't running* | Open Allume, or turn on *Launch Allume if needed*. |
| *Allume's MCP server is turned off* / *offered no tools* | Allume → Preferences → MCP → on. |
| Cards aren't moved | Switch MCP to **read-write**. A read-only server doesn't offer the move tool. |
| Phone captures arrive late | Allume syncs your phone to your Mac through its own service, and the Mac app has to be open to receive them. Open Allume on your phone for a moment after capturing. |
| Something looks wrong | Run **Show raw Allume responses**, copy the output and open an issue. Allume documents its MCP tool names but not the shape of their responses, so new Allume releases can need small fixes here. |

## Disclosures

- **Requires a third-party app.** You need [Allume](https://allume.com) for Mac (version 4.0 or later). Allume's own account and pricing apply.
- **No network use.** The plugin makes no network requests and has no telemetry. It talks only to Allume's local helper on your Mac.
- **Runs a local program.** It starts Allume's helper (`allume-cli mcp`) and, if you turn on *Launch Allume if needed*, opens Allume with `open -a Allume`.
- **Reads files outside your vault.** To copy an attachment, it reads the file Allume puts on disk for that card (in Allume's own storage), then saves a copy into your vault.
- **Changes data in Allume only if you ask.** With *After sync* set to *Remove* or *Move*, it soft-deletes or moves cards in Allume after they are saved in your vault.
- **Debug log.** When turned on, it writes Allume's requests and responses (including card content) to `debug.log` in the plugin's own folder. It's off by default.
- Allume's MCP server can see every workspace and board; there's no per-board permission. The plugin only reads the source you choose.

## Development

Everything goes through `./go`:

```bash
./go setup                 # install dependencies
./go check                 # lint + tests + build
./go install ~/MyVault     # build and copy into a vault for manual testing
./go release patch         # bump, check, commit, tag, push, GitHub release
./go help                  # all commands
```

Releases need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). The tag always equals the manifest version (no `v` prefix), as Obsidian requires.

`test/fake-allume.mjs` is a stand-in for `allume-cli mcp`. Its argument names deliberately differ from the plugin's first guesses: the plugin reads each tool's input schema at runtime and maps arguments from that.

| File | Role |
|---|---|
| `src/mcp.ts` | Minimal MCP client over stdio (no SDK dependency) |
| `src/allume.ts` | Allume tools, with schema-driven argument names |
| `src/cards.ts` | Turns MCP responses into cards and content, defensively |
| `src/format.ts` | How a capture is written; inserting under a heading |
| `src/sync.ts` | The sync engine, independent of Obsidian |
| `src/main.ts`, `src/ui.ts` | Obsidian commands, settings, scheduling |

## License

MIT
