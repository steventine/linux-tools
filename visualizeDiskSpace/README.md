# Visualize Disk Space

Often when using cloud based storage (like OneDrive or Dropbox) there are disk quotas.  As you approach the quota, it would be useful to be able to easily understand where the bulk of the storage is being spent but it's particularly difficult when files are spread across numerous directories and sub-directories.

This project provides a tool to analyze all the storage used across all the directories and provides an interactive tool to easily see how the disk space is used.  Users can see what percentage of the space is used in the top level directories, and then to explore how the disk space is used within that directory.  

## UI / UX

The interactive display is provided via an interactive HTML view. When visualizing a directory, the content are sorted from largest to smallest.  Two percentage values are provided for each file/folder: 1) What percentage of the current directory's total comes from the file/folder and 2) What percentage of the full parent directory's total (i.e. all the space in the cloud storage) comes from the file/folder

## Implementation

Phase 1 is implemented as a **NodeJS CLI** that scans a directory tree and generates a **single static HTML report**.

### Prerequisites

- NodeJS 18+ installed and available on your `PATH`.

### Basic usage

From the repo root:

```bash
node visualizeDiskSpace/index.mjs <rootDir> [options]
```

- `<rootDir>`: directory to scan (for example your cloud-synced folder).
- The script writes a self-contained HTML file that you can open directly in any browser.

Example (scan the current repo and write `test-report.html`):

```bash
node visualizeDiskSpace/index.mjs . -o visualizeDiskSpace/test-report.html --max-depth 1 --exclude node_modules --exclude .git
```

Example (scan a OneDrive folder on WSL):

```bash
node visualizeDiskSpace/index.mjs /mnt/c/Users/steve/OneDrive -o visualizeDiskSpace/onedrive-report.html --max-depth 3
```

### CLI options

- `-o, --output <file>`: Output HTML file path.  
  - Default: `disk-usage.html` in the current working directory.
- `--max-depth <n>`: Maximum directory depth to scan.  
  - `0` = only the root node.  
  - `1` = root + immediate children.  
  - Higher values go deeper into the tree.
- `--exclude <pattern>`: Exclude entries whose **names contain** the given substring.  
  - Can be repeated.  
  - Useful for skipping things like `node_modules`, `.git`, `desktop.ini`, `*.lnk`, etc.
- `-h, --help`: Show usage help.

### Generated report

The output HTML contains:

- A **breadcrumb** for navigating up and down the directory hierarchy.
- A **summary** of the current directory (path, size, root size, entry count).
- A **table** of the current directory’s immediate children:
  - Name (with folder/file icon and optional path snippet).
  - Size (human-readable).
  - **% of current directory**.
  - **% of root directory**.
  - A horizontal bar showing the relative share within the current directory.

You can:

- Click a **folder row** to drill down into that directory.
- Click parts of the **breadcrumb** to jump back up.

### Future phases

Planned future work includes:

- Additional visualizations (for example treemaps or sunburst-style views).
- Filters and highlighting for large files/folders.
- Additional polish for the look-and-feel of the report.