#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = argv.slice(2);
  let rootPath = null;
  let outputPath = null;
  let maxDepth = Infinity;
  const exclude = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') && !rootPath) {
      rootPath = arg;
    } else if ((arg === '-o' || arg === '--output') && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (arg === '--max-depth' && i + 1 < args.length) {
      const d = Number(args[++i]);
      if (!Number.isNaN(d) && d >= 0) {
        maxDepth = d;
      }
    } else if (arg === '--exclude' && i + 1 < args.length) {
      exclude.push(args[++i]);
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  if (!rootPath) {
    printHelp('Error: root directory is required.');
    process.exit(1);
  }

  rootPath = path.resolve(rootPath);
  if (!outputPath) {
    outputPath = path.join(process.cwd(), 'disk-usage.html');
  } else {
    outputPath = path.resolve(outputPath);
  }

  return { rootPath, outputPath, maxDepth, exclude };
}

function printHelp(errorMessage) {
  const msg = [];
  if (errorMessage) {
    msg.push(errorMessage, '');
  }
  msg.push(
    'Usage: node index.mjs <rootDir> [options]',
    '',
    'Options:',
    '  -o, --output <file>    Output HTML file (default: disk-usage.html in cwd)',
    '  --max-depth <n>        Maximum directory depth to scan (0=root only)',
    '  --exclude <pattern>    Exclude entries containing this substring (repeatable)',
    '  -h, --help             Show this help message'
  );
  console.error(msg.join('\n'));
}

function shouldExclude(name, excludes) {
  if (name === '.' || name === '..') return true;
  for (const pat of excludes) {
    if (name.includes(pat)) return true;
  }
  return false;
}

async function buildTree(rootPath, maxDepth, excludePatterns) {
  const rootStat = await fs.promises.stat(rootPath);
  const rootName = path.basename(rootPath);

  async function walk(currentPath, depth) {
    const name = depth === 0 ? rootName : path.basename(currentPath);
    const relPath = path.relative(rootPath, currentPath) || '.';
    const stat = await fs.promises.stat(currentPath);
    const isDir = stat.isDirectory();

    const node = {
      name,
      path: relPath.replace(/\\/g, '/'),
      size: 0,
      fileCount: 0,
      isDir,
      children: undefined
    };

    if (!isDir || depth >= maxDepth) {
      node.size = stat.size;
      node.fileCount = isDir ? 0 : 1;
      return node;
    }

    let total = 0;
    const children = [];
    let entries;
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch (err) {
      node.size = stat.size;
      node.fileCount = 0;
      return node;
    }

    for (const dirent of entries) {
      const childName = dirent.name;
      if (shouldExclude(childName, excludePatterns)) continue;

      const childPath = path.join(currentPath, childName);
      try {
        const childNode = await walk(childPath, depth + 1);
        total += childNode.size;
        children.push(childNode);
      } catch {
        // ignore errors on individual entries
      }
    }

    children.sort((a, b) => b.size - a.size);
    node.children = children;
    node.size = total || stat.size;
    node.fileCount = children.reduce((sum, c) => sum + (c.fileCount ?? 0), 0);
    return node;
  }

  return walk(rootPath, 0);
}

function humanSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function generateHtml(tree) {
  const dataJson = JSON.stringify(tree).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Disk Usage Report</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 0;
      background: #0f172a;
      color: #e5e7eb;
    }
    .app {
      max-width: 1100px;
      margin: 0 auto;
      padding: 1.5rem 1.25rem 2rem;
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.5rem;
      font-weight: 600;
    }
    .subtitle {
      font-size: 0.875rem;
      color: #9ca3af;
      margin-bottom: 1.25rem;
    }
    .breadcrumb {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.85rem;
      margin-bottom: 0.75rem;
      color: #9ca3af;
    }
    .breadcrumb span {
      cursor: default;
      user-select: none;
    }
    .breadcrumb button {
      background: transparent;
      border: none;
      padding: 0;
      margin: 0;
      color: #e5e7eb;
      cursor: pointer;
      font: inherit;
    }
    .breadcrumb button:hover {
      color: #38bdf8;
      text-decoration: underline;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      margin-bottom: 1rem;
      font-size: 0.85rem;
      color: #9ca3af;
    }
    .summary-item {
      background: #020617;
      border-radius: 0.5rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid #1f2937;
    }
    .summary-item strong {
      display: block;
      color: #e5e7eb;
      font-weight: 500;
      margin-bottom: 0.15rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #020617;
      border-radius: 0.75rem;
      overflow: hidden;
      box-shadow: 0 18px 45px rgba(15,23,42,0.75);
    }
    thead {
      background: #030712;
    }
    th, td {
      padding: 0.6rem 0.8rem;
      text-align: left;
      font-size: 0.8rem;
    }
    th {
      font-weight: 500;
      color: #9ca3af;
      border-bottom: 1px solid #1f2937;
      white-space: nowrap;
    }
    tbody tr {
      border-bottom: 1px solid #111827;
    }
    tbody tr:last-child {
      border-bottom: none;
    }
    tbody tr:hover {
      background: #030712;
    }
    tbody tr.dir {
      cursor: pointer;
    }
    .name-cell {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .name-main {
      font-size: 0.82rem;
    }
    .name-meta {
      font-size: 0.7rem;
      color: #6b7280;
    }
    .icon {
      width: 1rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #6b7280;
      font-size: 0.85rem;
    }
    .size-cell {
      white-space: nowrap;
    }
    .percent {
      white-space: nowrap;
    }
    .bar-cell {
      width: 180px;
    }
    .bar-outer {
      width: 100%;
      height: 0.45rem;
      border-radius: 999px;
      background: #020617;
      border: 1px solid #1f2937;
      overflow: hidden;
    }
    .bar-inner {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #38bdf8, #6366f1);
    }
    .empty {
      padding: 0.9rem 0.8rem;
      color: #6b7280;
      font-size: 0.82rem;
    }
    .hint {
      margin-top: 0.75rem;
      font-size: 0.75rem;
      color: #6b7280;
    }
    @media (max-width: 768px) {
      .app {
        padding: 1rem 0.75rem 1.5rem;
      }
      .bar-cell {
        display: none;
      }
      th:nth-child(4), td:nth-child(4),
      th:nth-child(5), td:nth-child(5) {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <h1>Disk Usage Report</h1>
    <div class="subtitle">Interactive view of disk space usage for a scanned directory.</div>
    <div id="breadcrumb" class="breadcrumb"></div>
    <div id="summary" class="summary"></div>
    <div id="table-container"></div>
    <div class="hint">
      Tip: Click on a folder row to drill down. Use the breadcrumb above to go back up.
    </div>
  </div>
  <script>
    window.diskData = ${dataJson};
  </script>
  <script>
    (function() {
      const root = window.diskData;
      const rootSize = root.size || 0;
      let currentPath = [];

      function humanSize(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        const value = bytes / Math.pow(1024, i);
        return value.toFixed(value >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
      }

      function findNode(pathArr) {
        if (pathArr.length === 0) return root;
        let node = root;
        for (const segment of pathArr) {
          if (!node.children) return node;
          const next = node.children.find(c => c.name === segment && c.isDir);
          if (!next) return node;
          node = next;
        }
        return node;
      }

      function renderBreadcrumb(node) {
        const el = document.getElementById('breadcrumb');
        el.innerHTML = '';
        const pathArr = currentPath;

        const makeSep = () => {
          const span = document.createElement('span');
          span.textContent = '/';
          return span;
        };

        const rootBtn = document.createElement('button');
        rootBtn.textContent = node.path === '.' ? node.name : (root.name || 'root');
        rootBtn.onclick = () => {
          currentPath = [];
          render();
        };
        el.appendChild(rootBtn);

        let accumulated = [];
        for (let i = 0; i < pathArr.length; i++) {
          accumulated.push(pathArr[i]);
          el.appendChild(makeSep());
          const btn = document.createElement('button');
          btn.textContent = pathArr[i];
          btn.onclick = () => {
            currentPath = pathArr.slice(0, i + 1);
            render();
          };
          el.appendChild(btn);
        }
      }

      function renderSummary(node) {
        const el = document.getElementById('summary');
        el.innerHTML = '';
        const items = [];

        items.push({
          label: 'Current directory',
          value: node.path === '.' ? (root.name || 'root') : node.path
        });
        items.push({
          label: 'Size (current)',
          value: humanSize(node.size || 0)
        });
        items.push({
          label: 'Size (entire root)',
          value: humanSize(rootSize)
        });
        if (node.children && node.children.length) {
          items.push({
            label: 'Entries in current directory',
            value: String(node.children.length)
          });
        }

        for (const it of items) {
          const div = document.createElement('div');
          div.className = 'summary-item';
          const title = document.createElement('strong');
          title.textContent = it.label;
          const val = document.createElement('div');
          val.textContent = it.value;
          div.appendChild(title);
          div.appendChild(val);
          el.appendChild(div);
        }
      }

      function renderTable(node) {
        const container = document.getElementById('table-container');
        container.innerHTML = '';

        const children = node.children || [];
        if (!children.length) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'No files or folders directly inside this directory (or scanning was limited by depth).';
          container.appendChild(empty);
          return;
        }

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        const headers = ['Name', 'Size', 'Files', '% of current', 'Visual (current)', '% of root', 'Visual (root)'];
        headers.forEach((h, idx) => {
          const th = document.createElement('th');
          th.textContent = h;
          if (idx === 4 || idx === 6) th.className = 'bar-cell';
          trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const parentSize = node.size || 0;

        for (const child of children) {
          const tr = document.createElement('tr');
          tr.className = child.isDir ? 'dir' : '';

          // Name
          const tdName = document.createElement('td');
          tdName.className = 'name-cell';
          const icon = document.createElement('span');
          icon.className = 'icon';
          icon.textContent = child.isDir ? '📁' : '📄';
          const nameWrap = document.createElement('div');
          const main = document.createElement('div');
          main.className = 'name-main';
          main.textContent = child.name;
          nameWrap.appendChild(main);
          if (!child.isDir) {
            const meta = document.createElement('div');
            meta.className = 'name-meta';
            meta.textContent = child.path === '.' ? '' : child.path;
            nameWrap.appendChild(meta);
          }
          tdName.appendChild(icon);
          tdName.appendChild(nameWrap);
          tr.appendChild(tdName);

          // Size
          const tdSize = document.createElement('td');
          tdSize.className = 'size-cell';
          tdSize.textContent = humanSize(child.size || 0);
          tr.appendChild(tdSize);

          // Files
          const tdFiles = document.createElement('td');
          tdFiles.className = 'size-cell';
          tdFiles.textContent = child.isDir ? (child.fileCount ?? 0) : 1;
          tr.appendChild(tdFiles);

          // % current
          const pctCurrent = parentSize > 0 ? (child.size / parentSize) * 100 : 0;
          const tdPctCurrent = document.createElement('td');
          tdPctCurrent.className = 'percent';
          tdPctCurrent.textContent = pctCurrent.toFixed(pctCurrent >= 10 ? 0 : 1) + '%';
          tr.appendChild(tdPctCurrent);

          // Visual (current)
          const tdBarCurrent = document.createElement('td');
          tdBarCurrent.className = 'bar-cell';
          const barOuterCurrent = document.createElement('div');
          barOuterCurrent.className = 'bar-outer';
          const barInnerCurrent = document.createElement('div');
          barInnerCurrent.className = 'bar-inner';
          barInnerCurrent.style.width = Math.max(0.5, pctCurrent) + '%';
          barOuterCurrent.appendChild(barInnerCurrent);
          tdBarCurrent.appendChild(barOuterCurrent);
          tr.appendChild(tdBarCurrent);

          // % root
          const pctRoot = rootSize > 0 ? (child.size / rootSize) * 100 : 0;
          const tdPctRoot = document.createElement('td');
          tdPctRoot.className = 'percent';
          tdPctRoot.textContent = pctRoot.toFixed(pctRoot >= 10 ? 0 : 1) + '%';
          tr.appendChild(tdPctRoot);

          // Visual (root)
          const tdBarRoot = document.createElement('td');
          tdBarRoot.className = 'bar-cell';
          const barOuterRoot = document.createElement('div');
          barOuterRoot.className = 'bar-outer';
          const barInnerRoot = document.createElement('div');
          barInnerRoot.className = 'bar-inner';
          barInnerRoot.style.width = Math.max(0.5, pctRoot) + '%';
          barOuterRoot.appendChild(barInnerRoot);
          tdBarRoot.appendChild(barOuterRoot);
          tr.appendChild(tdBarRoot);

          if (child.isDir) {
            tr.addEventListener('click', () => {
              currentPath = [...currentPath, child.name];
              render();
            });
          }

          tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        container.appendChild(table);
      }

      function render() {
        const node = findNode(currentPath);
        renderBreadcrumb(node);
        renderSummary(node);
        renderTable(node);
      }

      render();
    })();
  </script>
</body>
</html>`;
}

async function main() {
  const { rootPath, outputPath, maxDepth, exclude } = parseArgs(process.argv);
  try {
    const tree = await buildTree(rootPath, maxDepth, exclude);
    const html = generateHtml(tree);
    await fs.promises.writeFile(outputPath, html, 'utf8');
    console.error('Wrote disk usage report to ' + outputPath);
  } catch (err) {
    console.error('Error while generating report:', err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

main();

