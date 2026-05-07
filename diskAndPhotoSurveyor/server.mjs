import express from 'express';
import fs from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import net from 'net';
import sharp from 'sharp';
import { scanRoots, runExiftool } from './scanEngine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const THUMB_DIR = path.join(__dirname, '.thumbnails');
fs.mkdirSync(THUMB_DIR, { recursive: true });

function cachePath(index) {
  const name = config.scans[index]?.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return path.join(__dirname, `cache_${name}.json`);
}

function loadCache(index) {
  try { return JSON.parse(fs.readFileSync(cachePath(index), 'utf8')); } catch { return null; }
}

function saveCache(index, data) {
  fs.writeFileSync(cachePath(index), JSON.stringify(data), 'utf8');
}

// SSE broadcast — one active scan at a time
let sseClients = [];
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(res => res.write(data));
}

// Crypto-free hash for thumbnail filenames
import crypto from 'crypto';
function thumbKey(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

async function generateThumbnail(filePath, ext) {
  const key = thumbKey(filePath);
  const thumbPath = path.join(THUMB_DIR, key + '.jpg');
  if (fs.existsSync(thumbPath)) return thumbPath;

  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.webm', '.mts', '.m2ts']);
  if (VIDEO_EXTS.has(ext)) {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-ss', '1', '-i', filePath, '-frames:v', '1',
        '-vf', 'scale=800:800:force_original_aspect_ratio=decrease',
        '-y', thumbPath
      ], err => err ? reject(err) : resolve());
    });
  } else {
    await sharp(filePath)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);
  }
  return thumbPath;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Config ---
app.get('/api/config', (req, res) => {
  res.json(config.scans.map((scan, i) => {
    const cache = loadCache(i);
    return {
      index: i,
      name: scan.name,
      roots: scan.roots,
      cachedAt: cache?.scannedAt ?? null,
      fileCount: cache?.fileCount ?? null,
      photoCount: cache?.photoFiles?.length ?? null,
      hasExif: cache?.photos != null,
    };
  }));
});

// --- SSE progress stream ---
app.get('/api/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// --- Scan (walk phase) ---
app.post('/api/scan/:index', async (req, res) => {
  const index = parseInt(req.params.index);
  const scan = config.scans[index];
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  res.json({ ok: true });

  try {
    const { diskTrees, dupGroups, photoFiles } = await scanRoots(scan.roots, {
      onProgress: broadcast
    });

    const cache = {
      scannedAt: new Date().toISOString(),
      fileCount: photoFiles.length + dupGroups.confirmed.reduce((s, g) => s + g.files.length, 0),
      diskTrees,
      dupGroups,
      photoFiles,
      photos: null,
    };
    // Recompute actual fileCount from diskTrees
    cache.fileCount = diskTrees.reduce((s, t) => s + t.fileCount, 0);
    saveCache(index, cache);
    broadcast({ type: 'scan-saved', index });
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
  }
});

// --- Exiftool pass (opt-in) ---
app.post('/api/exiftool/:index', async (req, res) => {
  const index = parseInt(req.params.index);
  const cache = loadCache(index);
  if (!cache) return res.status(404).json({ error: 'No cached scan' });

  res.json({ ok: true });

  try {
    const photos = await runExiftool(cache.photoFiles, { onProgress: broadcast });
    cache.photos = photos;
    saveCache(index, cache);
    broadcast({ type: 'exif-saved', index, photoCount: photos.length });
  } catch (err) {
    broadcast({ type: 'error', message: err.message });
  }
});

// --- Data endpoints ---
app.get('/api/disk/:index', (req, res) => {
  const cache = loadCache(parseInt(req.params.index));
  if (!cache) return res.status(404).json({ error: 'No cached scan' });
  res.json({ diskTrees: cache.diskTrees, scannedAt: cache.scannedAt });
});

app.get('/api/dups/:index', (req, res) => {
  const cache = loadCache(parseInt(req.params.index));
  if (!cache) return res.status(404).json({ error: 'No cached scan' });
  res.json({ dupGroups: cache.dupGroups, scannedAt: cache.scannedAt });
});

app.get('/api/photos/:index', (req, res) => {
  const cache = loadCache(parseInt(req.params.index));
  if (!cache) return res.status(404).json({ error: 'No cached scan' });
  res.json({ photos: cache.photos, photoFiles: cache.photoFiles, scannedAt: cache.scannedAt });
});

// --- Albums ---
app.get('/api/albums/:index', (req, res) => {
  const index = parseInt(req.params.index);
  const cache = loadCache(index);
  if (!cache) return res.status(404).json({ error: 'No cached scan' });

  const scan = config.scans[index];
  const roots = scan.roots.map(r => r.path);
  const baseDir = req.query.dir || null;
  const photos = cache.photos ?? cache.photoFiles ?? [];

  const albumMap = new Map();
  for (const photo of photos) {
    const base = baseDir || roots.find(r => photo.path.startsWith(r + '/') || photo.path.startsWith(r + path.sep));
    if (!base) continue;
    const rel = photo.path.slice(base.length).replace(/^[/\\]/, '');
    const sep = rel.search(/[/\\]/);
    if (sep === -1) continue;
    const sub = rel.slice(0, sep);
    const subPath = base + '/' + sub;
    if (!albumMap.has(subPath)) albumMap.set(subPath, { name: sub, path: subPath, photos: [] });
    albumMap.get(subPath).photos.push(photo);
  }

  const albums = Array.from(albumMap.values()).map(album => {
    const sorted = [...album.photos].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const withDates = sorted.filter(p => p.date);
    const earliest = withDates.length ? withDates[withDates.length - 1].date.slice(0, 10) : null;
    const latest   = withDates.length ? withDates[0].date.slice(0, 10) : null;
    const dateRange = earliest && latest ? (earliest === latest ? earliest : `${earliest} – ${latest}`) : 'No dates';
    const hasSubAlbums = album.photos.some(p => {
      const rel = p.path.slice(album.path.length).replace(/^[/\\]/, '');
      return /[/\\]/.test(rel);
    });
    return { name: album.name, path: album.path, count: album.photos.length, coverPhoto: sorted[0]?.path ?? null, dateRange, hasSubAlbums };
  }).sort((a, b) => a.name.localeCompare(b.name));

  res.json({ albums });
});

// --- Delete files ---
app.post('/api/delete', async (req, res) => {
  const { paths } = req.body;
  if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be an array' });

  const results = [];
  for (const p of paths) {
    try {
      await fs.promises.unlink(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

// --- Update EXIF date ---
app.post('/api/update-date', (req, res) => {
  const { filePath, date } = req.body;
  if (!filePath || !date) return res.status(400).json({ error: 'filePath and date required' });

  // date expected as "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD"
  const exifDate = date.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1:$2:$3');
  execFile('exiftool', [
    `-DateTimeOriginal=${exifDate}`,
    `-CreateDate=${exifDate}`,
    '-overwrite_original',
    filePath
  ], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// --- Thumbnail ---
app.get('/api/thumbnail', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).end();
  const ext = path.extname(filePath).toLowerCase();
  try {
    const thumbPath = await generateThumbnail(filePath, ext);
    res.sendFile(thumbPath);
  } catch {
    res.status(500).end();
  }
});

// --- Preview (stream original) ---
app.get('/api/preview', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

function findOpenPort(start) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(findOpenPort(start + 1)));
    s.once('listening', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.listen(start);
  });
}

const port = await findOpenPort(config.port ?? 3001);
app.listen(port, () => console.log(`diskAndPhotoSurveyor running at http://localhost:${port}`));
