import express from 'express';
import { execFile } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { resolve, dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
} catch {
  console.error('Could not read config.json — copy config.json and edit it with your scan directories.');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Cache files are named per-scan so switching scans doesn't require a re-run.
function cacheFilePath(scan) {
  const safe = scan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return join(__dirname, `cache_${safe}.json`);
}

// Normalize a scan's dirs to always be { path, thumbnails } objects.
// Supports both plain strings (uses scan-level thumbnails default) and objects.
function normalizeDirs(scan) {
  const scanDefault = scan.thumbnails ?? false;
  return scan.dirs.map(d =>
    typeof d === 'string'
      ? { path: d, thumbnails: scanDefault }
      : { path: d.path, thumbnails: d.thumbnails ?? scanDefault }
  );
}

// Confirm a path is inside one of the configured scan directories before
// serving or deleting it, to prevent directory traversal.
function isAllowedPath(filePath) {
  const abs = resolve(filePath);
  return config.scans.flatMap(normalizeDirs).some(d => {
    const absDir = resolve(d.path);
    return abs.startsWith(absDir + '/') || abs === absDir;
  });
}

// --- API routes ---

app.get('/api/config', (req, res) => {
  const scans = config.scans.map((scan, index) => ({
    index,
    name: scan.name,
    dirs: normalizeDirs(scan),   // each entry: { path, thumbnails }
    cached: existsSync(cacheFilePath(scan)),
  }));
  res.json({ scans, useTrash: config.useTrash ?? false });
});

app.get('/api/dups/:index', (req, res) => {
  const scan = config.scans[parseInt(req.params.index, 10)];
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const cf = cacheFilePath(scan);
  if (!existsSync(cf)) return res.status(404).json({ error: 'No cached data — run Refresh first.' });
  res.sendFile(cf);
});

// Runs findDups.sh --json and writes the result to the scan's cache file.
// Can take a while for large directory trees; the client shows a loading state.
app.post('/api/refresh/:index', async (req, res) => {
  const scan = config.scans[parseInt(req.params.index, 10)];
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  const script = join(__dirname, 'findDups.sh');
  try {
    const { stdout } = await execFileAsync('bash', [script, '--json', '--size', ...normalizeDirs(scan).map(d => d.path)], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    writeFileSync(cacheFilePath(scan), JSON.stringify(data, null, 2));
    res.json({ ok: true, confirmed: data.confirmed.length, nameOnly: data.nameOnly.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletes a list of files. Each path is validated against configured scan dirs.
// Every deletion (success or failure) is appended to deletions.log.
app.post('/api/delete', async (req, res) => {
  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array' });
  }

  const logFile = join(__dirname, config.logFile ?? 'deletions.log');
  const results = [];

  for (const p of paths) {
    if (!isAllowedPath(p)) {
      results.push({ path: p, ok: false, error: 'Path not within configured scan directories' });
      continue;
    }
    const abs = resolve(p);
    try {
      if (config.useTrash) {
        await execFileAsync('trash-put', [abs]);
      } else {
        await unlink(abs);
      }
      appendFileSync(logFile, `${new Date().toISOString()}\tDELETED\t${abs}\n`);
      results.push({ path: p, ok: true });
    } catch (err) {
      appendFileSync(logFile, `${new Date().toISOString()}\tFAILED\t${abs}\t${err.message}\n`);
      results.push({ path: p, ok: false, error: err.message });
    }
  }

  res.json({ results });
});

// Serves a file for inline preview (images, video, audio).
// Only accessible for paths within configured scan directories.
const MIME_TYPES = {
  // Images
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heif',
  '.tiff': 'image/tiff', '.tif': 'image/tiff',
  // Video
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4', '.wmv': 'video/x-ms-wmv',
  // Audio
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac',
};

app.get('/api/preview', (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).send('Missing path parameter');
  if (!isAllowedPath(p)) return res.status(403).send('Forbidden');
  const abs = resolve(p);
  if (!existsSync(abs)) return res.status(404).send('File not found');

  const mime = MIME_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  createReadStream(abs).pipe(res);
});

const port = config.port ?? 3000;
app.listen(port, () => {
  console.log(`Duplicate reviewer running at http://localhost:${port}`);
});
