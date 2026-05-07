# Disk & Photo Surveyor

A unified tool for analysing local and cloud-connected file systems. A single filesystem walk feeds three independent views:

| Tab | What it does |
|-----|-------------|
| **💾 Disk Space** | Drill-down directory tree with dual progress bars showing % of parent and % of root |
| **🔍 Duplicates** | Groups files by name (and size), with inline previews, extension filtering, and one-click deletion |
| **📷 Timeline** | Justified photo/video grid organised by month and day, with a year scrubber, album view, and inline EXIF date editing |

Real-time scan progress is streamed to the browser via Server-Sent Events.

## Features

- **Single scan, three views** — one filesystem walk populates all three tabs simultaneously
- **Cloud-storage aware** — roots marked `isCloudStored: true` are never content-read, so OneDrive / Dropbox / Google Drive placeholder files are handled safely (name and `stat` only)
- **Opt-in EXIF scan** — photo metadata (dates, dimensions) is extracted on demand via `exiftool` with per-file progress; the fast walk completes first so Disk and Duplicates are usable immediately
- **On-demand thumbnails** — generated via `sharp` (images) and `ffmpeg` (videos), cached in `.thumbnails/`
- **Duplicate management** — confirmed duplicates (same name + size) vs. name-only matches, extension filter chips, sort by size, skip/undo per group, space-savings estimate, modal confirmation before deletion
- **Album view** — browse photos by directory hierarchy with breadcrumb navigation
- **Date editing** — update EXIF timestamps directly from the lightbox

## Requirements

| Dependency | Purpose |
|------------|---------|
| [Node.js](https://nodejs.org) 18+ | Server runtime |
| [exiftool](https://exiftool.org) | EXIF metadata extraction (optional — timeline still works without it using file modification dates) |
| [ffmpeg](https://ffmpeg.org) | Video thumbnail generation (optional) |

## Setup

```bash
# 1. Clone / copy the project
cd diskAndPhotoSurveyor

# 2. Install Node dependencies
npm install

# 3. Edit config.json to point at your directories
```

## Configuration

Edit `config.json` before running. Each scan can have one or more root directories:

```json
{
  "port": 3001,
  "scans": [
    {
      "name": "OneDrive",
      "roots": [
        { "path": "/mnt/c/Users/you/OneDrive", "isCloudStored": true }
      ]
    },
    {
      "name": "Local Photos",
      "roots": [
        { "path": "/mnt/d/Photos", "isCloudStored": false }
      ]
    },
    {
      "name": "Local vs Cloud (compare)",
      "roots": [
        { "path": "/mnt/d/Photos",             "isCloudStored": false },
        { "path": "/mnt/c/Users/you/OneDrive", "isCloudStored": true }
      ]
    }
  ]
}
```

**`isCloudStored: true`** — the tool will read filenames and sizes via `stat`, but will never open file contents. This prevents cloud-storage clients from downloading placeholder files just to inspect them. Set this for any OneDrive, Dropbox, or Google Drive directory.

If port `3001` is already in use the server will automatically try `3002`, `3003`, and so on.

## Running

```bash
npm start
```

Then open the URL printed in the terminal (e.g. `http://localhost:3001`).

## Workflow

1. **Select a scan** from the dropdown and click **↻ Scan**
   - The filesystem walk runs immediately and populates Disk Space and Duplicates
2. **Switch to the Timeline tab** and click **Run EXIF Scan** to extract photo dates and dimensions
   - Progress is shown per-file; the scan can be re-run at any time to refresh
3. **Disk Space** — click any folder to drill down; breadcrumb to navigate back
4. **Duplicates** — use extension chips to filter, mark files for deletion, then click the floating button to review and confirm
5. **Timeline** — use the year scrubber or **Jump to Month** to navigate; click a photo to open the lightbox; edit EXIF dates with the ✎ button

## Notes

- Scan results are cached in `cache_<name>.json` (gitignored) so the browser loads instantly on revisit without re-scanning
- Thumbnails are cached in `.thumbnails/` (gitignored); delete the folder to regenerate
- File deletion is permanent (`rm`) — there is no Recycle Bin for WSL paths into the Windows filesystem
