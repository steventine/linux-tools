import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';

const PHOTO_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
  '.tiff', '.tif', '.bmp', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2'
]);
const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.webm', '.mts', '.m2ts'
]);

function isMediaFile(ext) {
  return PHOTO_EXTS.has(ext) || VIDEO_EXTS.has(ext);
}

function normalizeName(filename) {
  return filename.toLowerCase();
}

// Build an empty disk tree node
function makeNode(name, fullPath) {
  return { name, path: fullPath, size: 0, fileCount: 0, children: {} };
}

// Walk a single root directory, accumulating into shared data structures.
// dupMap: Map<normalizedBasename, [{path, size, mtime, rootPath}]>
// photoFiles: [{path, size, mtime, ext, isCloudStored}]
// diskRootNode: disk tree node for this root
async function walkRoot(rootPath, isCloudStored, dupMap, photoFiles, onProgress) {
  const diskNode = makeNode(path.basename(rootPath), rootPath);

  async function walk(dirPath, parentNode) {
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const childNode = makeNode(entry.name, fullPath);
        parentNode.children[entry.name] = childNode;
        await walk(fullPath, childNode);
        parentNode.size += childNode.size;
        parentNode.fileCount += childNode.fileCount;
      } else if (entry.isFile()) {
        let size = 0;
        let mtime = null;
        try {
          const st = await fs.promises.stat(fullPath);
          size = st.size;
          mtime = st.mtime.toISOString();
        } catch {
          // unreadable placeholder — record with zero size
        }

        parentNode.size += size;
        parentNode.fileCount += 1;

        // Dup tracking (name-based; safe for cloud placeholders)
        const ext = path.extname(entry.name).toLowerCase();
        const key = normalizeName(entry.name);
        if (!dupMap.has(key)) dupMap.set(key, []);
        dupMap.get(key).push({ path: fullPath, size, mtime, rootPath, isCloudStored });

        // Photo/video tracking
        if (isMediaFile(ext)) {
          photoFiles.push({ path: fullPath, size, mtime, ext, isCloudStored });
        }

        onProgress(fullPath);
      }
    }
  }

  await walk(rootPath, diskNode);
  return diskNode;
}

// Collapse the children map into a sorted array for JSON output
function finalizeDiskNode(node) {
  const children = Object.values(node.children)
    .map(finalizeDiskNode)
    .sort((a, b) => b.size - a.size);
  return { name: node.name, path: node.path, size: node.size, fileCount: node.fileCount, children };
}

// Build dup groups: only groups with >1 file are duplicates
function buildDupGroups(dupMap) {
  const confirmed = [];   // same name AND same size across all entries
  const nameOnly = [];    // same name, different sizes (or any unreadable)

  for (const [key, files] of dupMap) {
    if (files.length < 2) continue;

    const hasUnreadable = files.some(f => f.size === 0 && f.mtime === null);
    const sizes = new Set(files.map(f => f.size));
    const allSameSize = sizes.size === 1 && !hasUnreadable;

    const group = { label: files[0].path.split('/').pop(), files };
    if (allSameSize) {
      confirmed.push(group);
    } else {
      nameOnly.push({ ...group, hasUnreadable });
    }
  }

  confirmed.sort((a, b) => b.files[0].size - a.files[0].size);
  nameOnly.sort((a, b) => a.label.localeCompare(b.label));

  return { confirmed, nameOnly };
}

// Main scan: walk all roots, return all three datasets + metadata
export async function scanRoots(roots, { onProgress }) {
  const dupMap = new Map();
  const photoFiles = [];
  const diskTrees = [];
  let fileCount = 0;

  const progressHandler = (currentPath) => {
    fileCount++;
    if (fileCount % 50 === 0) onProgress({ type: 'walk-progress', count: fileCount, currentPath });
  };

  for (const root of roots) {
    const node = await walkRoot(root.path, root.isCloudStored, dupMap, photoFiles, progressHandler);
    diskTrees.push(finalizeDiskNode(node));
  }

  const dupGroups = buildDupGroups(dupMap);

  onProgress({ type: 'walk-complete', fileCount, photoCount: photoFiles.length });

  return { diskTrees, dupGroups, photoFiles };
}

// Optional exiftool pass — single spawn with -progress for streaming updates every 10 files
export async function runExiftool(photoFiles, { onProgress }) {
  if (photoFiles.length === 0) return [];

  const paths = photoFiles.map(f => f.path);
  const total = paths.length;
  const results = new Map(photoFiles.map(f => [f.path, { ...f, date: null, width: null, height: null }]));

  // Write paths to a temp file so we don't hit arg-list length limits on large libraries
  const tmpFile = path.join(tmpdir(), `dps-exif-${Date.now()}.txt`);
  await writeFile(tmpFile, paths.join('\n'), 'utf8');

  const csvRows = await new Promise((resolve, reject) => {
    const proc = spawn('exiftool', [
      '-csv', '-fast2', '-progress',
      '-DateTimeOriginal', '-CreateDate', '-FileModifyDate',
      '-ImageWidth', '-ImageHeight', '-MIMEType',
      '-@', tmpFile,
    ]);

    let stdout = '';
    let stderrBuf = '';
    let lastReported = 0;
    const REPORT_EVERY = 10;

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });

    proc.stderr.on('data', chunk => {
      // Buffer stderr and process complete lines only, so a chunk boundary
      // in the middle of a line doesn't break the match.
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop(); // keep the incomplete trailing fragment

      for (const line of lines) {
        // exiftool -progress writes "   N/ M  /path/to/file" to stderr.
        // Validate that the parsed total matches our known total so that
        // numbers embedded in file paths (e.g. /2024/1099/img.jpg) are ignored.
        const m = line.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
          const done        = parseInt(m[1]);
          const parsedTotal = parseInt(m[2]);
          if (parsedTotal === total && done <= total) {
            if (done - lastReported >= REPORT_EVERY || done === total) {
              lastReported = done;
              onProgress({ type: 'exif-progress', done, total });
            }
          }
        }
      }
    });

    proc.on('close', () => resolve(stdout));
    proc.on('error', err => resolve(''));  // exiftool not installed — return empty
  });

  await unlink(tmpFile).catch(() => {});

  // Parse the accumulated CSV
  const lines = csvRows.trim().split('\n').filter(Boolean);
  if (lines.length > 1) {
    const headers = lines[0].split(',').map(h => h.trim());
    const idx = {
      file: headers.indexOf('SourceFile'),
      dto:  headers.indexOf('DateTimeOriginal'),
      cd:   headers.indexOf('CreateDate'),
      fmd:  headers.indexOf('FileModifyDate'),
      w:    headers.indexOf('ImageWidth'),
      h:    headers.indexOf('ImageHeight'),
      mime: headers.indexOf('MIMEType'),
    };

    for (let j = 1; j < lines.length; j++) {
      const cols = lines[j].split(',');
      const filePath = cols[idx.file]?.replace(/^"|"$/g, '');
      if (!filePath || !results.has(filePath)) continue;

      const rawDate = cols[idx.dto] || cols[idx.cd] || cols[idx.fmd] || '';
      const date = rawDate ? rawDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : null;

      results.get(filePath).date   = date;
      results.get(filePath).width  = parseInt(cols[idx.w]) || null;
      results.get(filePath).height = parseInt(cols[idx.h]) || null;
      results.get(filePath).mime   = cols[idx.mime] || null;
    }
  }

  onProgress({ type: 'exif-complete' });

  return Array.from(results.values()).sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
}
