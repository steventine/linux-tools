# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the web reviewer
npm start          # http://localhost:3000

# CLI usage (standalone, no server needed)
./findDups.sh dir1 dir2          # name match only (default, case-insensitive)
./findDups.sh --size dir1 dir2   # also require matching file size
./findDups.sh --hash dir1 dir2   # also verify content via md5sum
./findDups.sh --json dir1 dir2   # JSON output (used internally by server.mjs)
```

## Architecture

```
findDups.sh  ──[--json]──►  cache_<scan-name>.json  ──►  server.mjs  ──►  browser UI
                                                              │
                                                         deletions.log (append-only)
```

**`findDups.sh`** — pure bash, no dependencies. Builds a case-insensitive basename map via `find`, then classifies groups as confirmed duplicates or name-only matches. With `--json`, emits a single JSON object `{ confirmed: [...], nameOnly: [...] }` instead of human-readable text. Paths with spaces are handled throughout via array args and quoted variables.

**`config.json`** — defines named scans (each with one or two directories and a `thumbnails` flag), port, log file path, and `useTrash` flag. Each scan gets its own cache file so switching between scans doesn't require re-running the script.

**`server.mjs`** — Express server (ESM). Key routes:
- `GET /api/config` — scan list with cache status
- `GET /api/dups/:index` — reads `cache_<name>.json` for that scan
- `POST /api/refresh/:index` — spawns `findDups.sh --json`, writes cache file
- `POST /api/delete` — deletes files (validates paths are within configured dirs), appends to `deletions.log`
- `GET /api/preview?path=` — streams file for image/video/audio preview; path is validated against configured dirs before serving

**`public/index.html`** — single-file SPA (vanilla JS, no build step). State is a plain object; groups re-render in place on each decision to avoid full-list thrashing. Decision flow: mark files to keep → floating button shows count → confirmation modal lists files → POST /api/delete → per-file result shown in modal.

## Key design decisions

- **Thumbnails off by default** — OneDrive "Files On-Demand" placeholders require downloading the full file to serve content. Set `"thumbnails": true` per scan only for locally-available directories.
- **Video/audio always available** — `<video>` and `<audio>` elements only fetch on user-initiated play, so they work even for remote files without pre-downloading.
- **Cache per scan** — named `cache_<sanitized-scan-name>.json`. Listed in `.gitignore`.
- **`deletions.log` is append-only** — the server never truncates it; it's the audit trail for all deletions.
- **Path safety** — the preview and delete endpoints both validate that the requested path resolves to within a configured scan directory.

## WSL / OneDrive notes

- Run from WSL; directories are typically `/mnt/d/...` paths into the Windows filesystem.
- `useTrash: false` (default) is correct for `/mnt/` paths — `trash-put` on WSL does not use the Windows Recycle Bin and would copy the file to the Linux filesystem, triggering a full OneDrive download.
- Prefer `rm` (the default) with the UI confirmation step as the safety mechanism.
