import express from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createReadStream } from 'fs';
import { stat, mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import sharp from 'sharp';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// ── Config ───────────────────────────────────────────────────────────────────
const config = JSON.parse(await readFile(path.join(__dirname, 'config.json'), 'utf8'));
const THUMB_DIR = path.join(__dirname, '.thumbnails');
await mkdir(THUMB_DIR, { recursive: true });

// ── Port discovery ────────────────────────────────────────────────────────────
async function findOpenPort(start) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(findOpenPort(start + 1)));
    s.once('listening', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.listen(start);
  });
}

// ── Path security ─────────────────────────────────────────────────────────────
function isAllowedPath(filePath) {
  const norm = path.normalize(filePath);
  return config.scans.some(scan =>
    scan.dirs.some(dir => norm.startsWith(path.normalize(dir) + path.sep))
  );
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
function cacheFile(i) {
  const name = config.scans[i].name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return path.join(__dirname, `cache_${name}.json`);
}

async function readCache(i) {
  try { return JSON.parse(await readFile(cacheFile(i), 'utf8')); }
  catch { return null; }
}

// ── MIME / extension maps ─────────────────────────────────────────────────────
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', wmv: 'video/x-ms-wmv', m4v: 'video/mp4',
  '3gp': 'video/3gpp', mts: 'video/mp2t', m2ts: 'video/mp2t',
};
const VIDEO_EXTS = new Set(['mp4','mov','avi','mkv','wmv','m4v','3gp','mts','m2ts']);

function mimeFromExt(p) {
  return EXT_MIME[path.extname(p).slice(1).toLowerCase()] ?? null;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvRow(line) {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  return (out.push(cur), out);
}

function parseExifDate(s) {
  if (!s || /^[0 :]+$/.test(s)) return null;
  // "2024:01:15 14:30:00" → ISO 8601
  const iso = s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

// ── SSE progress broadcast ────────────────────────────────────────────────────
// scanIndex → Set of Express response objects
const sseClients = new Map();

function broadcastProgress(index, payload) {
  const clients = sseClients.get(index);
  if (!clients?.size) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ── Scan ──────────────────────────────────────────────────────────────────────

// Runs exiftool, streaming stderr to the terminal AND parsing progress lines.
// onProgress({ pct, current, total }) is called for each parsed progress update.
function spawnExiftool(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('exiftool', args);
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));

    let buf = '';
    proc.stderr.on('data', d => {
      const text = d.toString();
      process.stderr.write(text); // still visible in terminal
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop(); // keep any incomplete line
      for (const line of lines) {
        const m = line.match(/(\d+\.?\d*)%(?:\s+\(\s*(\d+)\s+of\s+(\d+)\))?/);
        if (m) onProgress?.({ pct: parseFloat(m[1]), current: parseInt(m[2]) || 0, total: parseInt(m[3]) || 0 });
      }
    });

    proc.on('error', reject);
    proc.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function runScan(index) {
  const scan = config.scans[index];
  const validDirs = [];
  for (const dir of scan.dirs) {
    try { if ((await stat(dir)).isDirectory()) validDirs.push(dir); }
    catch { console.warn(`  skipping missing dir: ${dir}`); }
  }
  if (!validDirs.length) throw new Error('No valid directories found');

  console.log(`\n[scan] "${scan.name}"`);
  validDirs.forEach(d => console.log(`       ${d}`));
  broadcastProgress(index, { phase: 'starting' });

  const photos = [];
  let hasExif = false;

  try {
    // Single exiftool pass: dates + dimensions + mime + size.
    // -progress writes a running percentage to stderr so the user sees activity.
    const args = [
      '-r', '-csv', '-progress',
      '-DateTimeOriginal', '-CreateDate', '-FileModifyDate',
      '-MIMEType', '-FileSize#',
      '-ImageWidth', '-ImageHeight',
      ...validDirs,
    ];
    console.log('[scan] running exiftool (this may take a few minutes)...');

    // Throttle UI updates to ~4 per second
    let lastBroadcast = 0;
    const stdout = await spawnExiftool(args, prog => {
      const now = Date.now();
      if (now - lastBroadcast >= 250) {
        broadcastProgress(index, { phase: 'scanning', ...prog });
        lastBroadcast = now;
      }
    });

    console.log(`[scan] parsing metadata (${(stdout.length / 1024).toFixed(0)} KB)...`);
    broadcastProgress(index, { phase: 'processing' });

    const lines = stdout.split('\n');
    const headers = csvRow(lines[0] ?? '');
    const col = name => headers.indexOf(name);
    const iSrc  = col('SourceFile');
    const iDto  = col('DateTimeOriginal');
    const iCd   = col('CreateDate');
    const iFmd  = col('FileModifyDate');
    const iMime = col('MIMEType');
    const iSize = col('FileSize');
    const iW    = col('ImageWidth');
    const iH    = col('ImageHeight');

    hasExif = true;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const f = csvRow(line);
      const filePath = f[iSrc]?.trim();
      if (!filePath) continue;

      const mime = f[iMime]?.trim() || mimeFromExt(filePath) || '';
      if (!mime.startsWith('image/') && !mime.startsWith('video/')) continue;

      const date = parseExifDate(f[iDto])
        ?? parseExifDate(f[iCd])
        ?? parseExifDate(f[iFmd])
        ?? new Date(0);

      photos.push({
        path: filePath,
        date: date.toISOString(),
        size: parseInt(f[iSize]) || 0,
        type: mime.startsWith('video/') ? 'video' : 'image',
        mime,
        w: parseInt(f[iW]) || null,
        h: parseInt(f[iH]) || null,
      });
    }
    console.log(`[scan] found ${photos.length} photos/videos`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // exiftool not installed — fall back to find + stat (dates only, no dimensions)
    console.warn('[scan] exiftool not found — falling back to file mtime (install libimage-exiftool-perl for EXIF dates)');
    for (const dir of validDirs) {
      console.log(`[scan] listing files in ${dir}...`);
      let findOut;
      try {
        ({ stdout: findOut } = await execFileAsync('find', [dir, '-type', 'f'], { maxBuffer: 100 * 1024 * 1024 }));
      } catch { continue; }
      for (const fp of findOut.split('\n').filter(Boolean)) {
        const mime = mimeFromExt(fp);
        if (!mime) continue;
        try {
          const s = await stat(fp);
          photos.push({ path: fp, date: s.mtime.toISOString(), size: s.size,
            type: mime.startsWith('video/') ? 'video' : 'image', mime, w: null, h: null });
        } catch { /* unreadable */ }
      }
      console.log(`[scan] ${photos.length} media files found so far`);
    }
  }

  // Newest first
  photos.sort((a, b) => b.date.localeCompare(a.date));
  console.log(`[scan] writing cache (${photos.length} items)...`);

  const cache = { scannedAt: new Date().toISOString(), totalCount: photos.length, hasExif, photos };
  await writeFile(cacheFile(index), JSON.stringify(cache), 'utf8');
  console.log(`[scan] done.\n`);
  broadcastProgress(index, { phase: 'done', totalCount: photos.length });
  return cache;
}

// ── Thumbnails ────────────────────────────────────────────────────────────────
function thumbPath(filePath) {
  return path.join(THUMB_DIR, createHash('md5').update(filePath).digest('hex') + '.jpg');
}

async function ensureThumbnail(filePath) {
  const dest = thumbPath(filePath);
  try { await stat(dest); return dest; } catch {}

  const ext = path.extname(filePath).slice(1).toLowerCase();

  if (VIDEO_EXTS.has(ext)) {
    // Grab frame at 1s via ffmpeg (optional; 404 if not installed)
    await execFileAsync('ffmpeg', [
      '-i', filePath, '-ss', '00:00:01', '-vframes', '1',
      '-vf', 'scale=800:800:force_original_aspect_ratio=decrease',
      '-f', 'image2', dest, '-y',
    ], { timeout: 30_000 });
  } else {
    // Resize to fit within 800×800, preserve aspect ratio, auto-rotate from EXIF
    await sharp(filePath)
      .rotate()
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toFile(dest);
  }
  return dest;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events endpoint — client subscribes before firing /api/refresh
app.get('/api/scan-progress', (req, res) => {
  const i = parseInt(req.query.index);
  if (isNaN(i) || !config.scans[i]) return res.status(400).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (!sseClients.has(i)) sseClients.set(i, new Set());
  sseClients.get(i).add(res);
  req.on('close', () => sseClients.get(i)?.delete(res));
});

app.get('/api/config', async (_req, res) => {
  const scans = await Promise.all(config.scans.map(async (scan, i) => {
    const cache = await readCache(i);
    return {
      name: scan.name,
      dirs: scan.dirs,
      cache: cache
        ? { exists: true, scannedAt: cache.scannedAt, totalCount: cache.totalCount, hasExif: cache.hasExif }
        : { exists: false },
    };
  }));
  res.json({ scans });
});

app.get('/api/photos/:index', async (req, res) => {
  const i = parseInt(req.params.index);
  if (isNaN(i) || !config.scans[i]) return res.status(400).json({ error: 'Invalid index' });
  const cache = await readCache(i);
  if (!cache) return res.status(404).json({ error: 'No cache — click Refresh to scan' });
  res.json(cache);
});

app.post('/api/refresh/:index', async (req, res) => {
  const i = parseInt(req.params.index);
  if (isNaN(i) || !config.scans[i]) return res.status(400).json({ error: 'Invalid index' });
  try {
    const { scannedAt, totalCount, hasExif } = await runScan(i);
    res.json({ ok: true, scannedAt, totalCount, hasExif });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// createReadStream's error event fires asynchronously after the try/catch exits,
// so we must attach an error listener or Node crashes on any read failure.
function pipeFile(src, res) {
  const stream = createReadStream(src);
  stream.on('error', err => {
    console.error('Stream error:', path.basename(src), err.message);
    if (!res.headersSent) res.status(500).send('Read error');
    else res.destroy();
  });
  stream.pipe(res);
}

app.get('/api/thumbnail', async (req, res) => {
  const fp = req.query.path;
  if (!fp || !isAllowedPath(fp)) return res.status(403).send('Forbidden');
  try { await stat(fp); } catch { return res.status(404).send('Not found'); }
  try {
    const tp = await ensureThumbnail(fp);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    pipeFile(tp, res);
  } catch (e) {
    console.error('Thumbnail error:', path.basename(fp), e.message);
    if (!res.headersSent) res.status(422).send('Cannot generate thumbnail');
  }
});

app.get('/api/preview', async (req, res) => {
  const fp = req.query.path;
  if (!fp || !isAllowedPath(fp)) return res.status(403).send('Forbidden');
  try {
    const s = await stat(fp);
    res.setHeader('Content-Type', mimeFromExt(fp) ?? 'application/octet-stream');
    res.setHeader('Content-Length', s.size);
    res.setHeader('Accept-Ranges', 'bytes');
    pipeFile(fp, res);
  } catch { if (!res.headersSent) res.status(404).send('Not found'); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const port = await findOpenPort(config.port ?? 3001);
app.listen(port, () => {
  console.log(`\n  Photo Timeline Viewer → http://localhost:${port}\n`);
});
