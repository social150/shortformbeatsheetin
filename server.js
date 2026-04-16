// server.js — Beat Sheet Editor with live Notion sync
// Run: node server.js
// Then open: http://localhost:3456

const http = require('http');
const { Client } = require('@notionhq/client');

// Load .env for local dev (no extra dependency needed)
try {
  require('fs').readFileSync(__dirname + '/.env', 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) { const k = line.slice(0, eq).trim(); const v = line.slice(eq + 1).trim(); if (k && !process.env[k]) process.env[k] = v; }
  });
} catch {}

// ============================================
// CONFIG — Update these or use env variables
// ============================================
const PORT = 3456;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const FIELD_TITLE = 'Idea';
const FIELD_HOOK = 'Hook';
const FIELD_BEATSHEET = 'Beat Sheet';
const FIELD_BEAT_SHEETIN = 'Beat Sheetin';
const FIELD_STATUS = 'Status';

const notion = new Client({ auth: NOTION_TOKEN });

// ============================================
// API
// ============================================
async function pullVideos() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: FIELD_BEAT_SHEETIN, checkbox: { equals: true } },
    page_size: 100
  });

  return response.results.map(page => {
    const p = page.properties;
    const title = p[FIELD_TITLE]?.title?.[0]?.plain_text || '';
    const hook = p[FIELD_HOOK]?.rich_text?.[0]?.plain_text || '';
    const status = p[FIELD_STATUS]?.status?.name || p[FIELD_STATUS]?.select?.name || '';
    const raw = p[FIELD_BEATSHEET]?.rich_text?.[0]?.plain_text || '';
    
    let roadmap;
    try { roadmap = raw ? JSON.parse(raw) : null; } catch { roadmap = null; }
    if (!roadmap) {
      roadmap = {
        segments: [
          { id: 1, type: 'hook', title: hook || '', desc: '', notes: '' },
          { id: 2, type: 'open-loop', title: '', desc: '', notes: '' },
          { id: 3, type: 'body', title: '', desc: '', notes: '' },
          { id: 4, type: 'payoff', title: '', desc: '', notes: '' },
          { id: 5, type: 'cta', title: '', desc: '', notes: '' }
        ]
      };
    }
    const videoUrl = p['URL']?.url || '';
    return { id: page.id, url: page.url, videoUrl, title, hook, status, roadmap };
  });
}

async function pushVideo(video) {
  await notion.pages.update({
    page_id: video.id,
    properties: {
      [FIELD_BEATSHEET]: {
        rich_text: [{ text: { content: JSON.stringify(video.roadmap) } }]
      }
    }
  });
}

async function pushVideosParallel(videos) {
  const CONCURRENCY = 3;
  for (let i = 0; i < videos.length; i += CONCURRENCY) {
    const batch = videos.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(v => pushVideo(v)));
  }
}

// ============================================
// SERVER
// ============================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/pull') {
    try {
      const videos = await pullVideos();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(videos));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/push') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const video = JSON.parse(body);
        await pushVideo(video);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/push-all') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const videos = JSON.parse(body);
        await pushVideosParallel(videos);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getHTML());
});

server.listen(PORT, () => {
  console.log('');
  console.log('🎬 Beat Sheet Editor running at http://localhost:' + PORT);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');
});

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Beat Sheet Editor</title>
  <style>
    :root {
      --bg: #0d0d12; --bg2: #16161e; --bg3: #1e1e28; --border: #2a2a3a;
      --text: #e8e8ed; --dim: #6b6b80;
      --hook: #3b82f6; --intro: #06b6d4; --open-loop: #f59e0b; --loop-back: #ea580c;
      --payoff: #22c55e; --cta: #a855f7; --body: #6366f1; --test: #64748b;
      --escalate: #ef4444; --wildcard: #ec4899; --b-story: #14b8a6; --conclusion: #8b5cf6;
      --prepare: #f97316; --purchase: #10b981;
      --stakes: #f43f5e; --comments: #94a3b8;
      --scale-w: 1; --scale-h: 1; --scale-t: 1;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 13px; }
    
    .header {
      position: sticky; top: 0; z-index: 100; background: var(--bg);
      border-bottom: 1px solid var(--border); padding: 12px 16px;
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .header h1 { font-size: 16px; font-weight: 600; }
    .sync-status { font-size: 11px; padding: 4px 10px; border-radius: 10px; background: var(--bg3); color: var(--dim); }
    .sync-status.syncing { background: var(--open-loop); color: #000; }
    .sync-status.saved { background: var(--payoff); color: #000; }
    .sync-status.error { background: var(--escalate); color: #fff; }
    .header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .btn { padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg2); color: var(--text); font-size: 12px; font-weight: 500; cursor: pointer; }
    .btn:hover { border-color: var(--dim); }
    .btn:disabled { opacity: 0.35; cursor: default; pointer-events: none; }
    .btn-primary { background: var(--hook); border-color: var(--hook); }
    .btn-green { background: var(--payoff); border-color: var(--payoff); color: #000; }

    .scale-controls { display: flex; align-items: center; gap: 8px; }
    .scale-controls label { font-size: 11px; color: var(--dim); white-space: nowrap; }
    .scale-controls input[type=range] { width: 80px; accent-color: var(--hook); cursor: pointer; }

    .filter-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); }
    .filter-bar label { font-size: 12px; color: var(--dim); }
    .filter-select { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; color: var(--text); font-size: 12px; }
    .status-counts { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
    .status-count { font-size: 11px; padding: 4px 10px; border-radius: 12px; background: var(--bg3); color: var(--dim); cursor: pointer; }
    .status-count:hover { background: var(--border); color: var(--text); }
    .status-count.active { background: var(--hook); color: white; }

    .legend { display: flex; gap: 12px; padding: 8px 16px; background: var(--bg); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dim); }
    .legend-dot { width: 10px; height: 10px; border-radius: 2px; }

    .videos { display: flex; flex-direction: column; }
    .video-row { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); min-height: calc(90px * var(--scale-h)); background: var(--bg2); }
    .video-row:nth-child(odd) { background: var(--bg); }
    .video-row:hover { background: var(--bg3); }
    .video-row.hidden { display: none; }

    .video-info { width: 200px; min-width: 200px; padding: 10px 12px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
    .video-meta { display: flex; align-items: center; gap: 8px; }
    .video-num { font-size: 10px; font-weight: 700; color: var(--dim); font-family: monospace; }
    .video-status { font-size: 9px; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: 10px; background: var(--bg3); color: var(--dim); }
    .video-title { font-size: 13px; font-weight: 600; color: var(--text); background: transparent; border: none; width: 100%; font-family: inherit; }
    .video-title:focus { outline: none; background: var(--bg3); border-radius: 3px; padding: 2px 4px; margin: -2px -4px; }
    .video-hook { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .segments { flex: 1; display: flex; align-items: center; gap: calc(4px * var(--scale-w)); padding: 8px 12px; overflow-x: auto; min-height: calc(90px * var(--scale-h)); }

    .seg {
      min-width: calc(120px * var(--scale-w)); max-width: calc(160px * var(--scale-w));
      flex-shrink: 0; background: var(--bg3); border-radius: 6px;
      padding: calc(6px * var(--scale-h)) calc(8px * var(--scale-w)); border-left: 3px solid var(--test);
      position: relative; cursor: grab; user-select: none;
    }
    .seg:active { cursor: grabbing; }
    .seg.dragging { opacity: 0.4; }
    .seg:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .seg.hook { border-color: var(--hook); }
    .seg.intro { border-color: var(--intro); }
    .seg.open-loop { border-color: var(--open-loop); background: linear-gradient(90deg, rgba(245,158,11,0.12) 0%, var(--bg3) 100%); }
    .seg.loop-back { border-color: var(--loop-back); background: linear-gradient(90deg, rgba(234,88,12,0.12) 0%, var(--bg3) 100%); }
    .seg.payoff { border-color: var(--payoff); background: linear-gradient(90deg, rgba(34,197,94,0.12) 0%, var(--bg3) 100%); }
    .seg.cta { border-color: var(--cta); }
    .seg.body { border-color: var(--body); }
    .seg.test { border-color: var(--test); }
    .seg.escalate { border-color: var(--escalate); }
    .seg.wildcard { border-color: var(--wildcard); }
    .seg.b-story { border-color: var(--b-story); background: linear-gradient(90deg, rgba(20,184,166,0.12) 0%, var(--bg3) 100%); }
    .seg.conclusion { border-color: var(--conclusion); }
    .seg.prepare { border-color: var(--prepare); background: linear-gradient(90deg, rgba(249,115,22,0.12) 0%, var(--bg3) 100%); }
    .seg.purchase { border-color: var(--purchase); background: linear-gradient(90deg, rgba(16,185,129,0.12) 0%, var(--bg3) 100%); }
    .seg.stakes { border-color: var(--stakes); background: linear-gradient(90deg, rgba(244,63,94,0.12) 0%, var(--bg3) 100%); }
    .seg.comments { border-color: var(--comments); }

    .video-info-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .url-btn { display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; background: var(--bg3); border: 1px solid var(--border); border-radius: 5px; color: var(--dim); font-size: 11px; font-weight: 700; text-decoration: none; letter-spacing: 0.05em; }
    .url-btn:hover { border-color: var(--hook); color: var(--hook); }
    .char-count { font-size: 10px; }

    .seg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 4px; overflow: hidden; }
    .seg-type {
      font-size: calc(9px * var(--scale-t)); font-weight: 600; text-transform: uppercase;
      background: var(--bg2); border: 1px solid var(--border); border-radius: 3px;
      padding: 2px 4px; color: var(--text); cursor: pointer; flex: 1; min-width: 0;
    }
    .seg-controls { display: flex; gap: 2px; flex-shrink: 0; }
    .seg-btn { width: 20px; height: 20px; border: none; border-radius: 3px; background: var(--bg2); color: var(--dim); font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .seg-btn:hover { background: var(--border); color: var(--text); }
    .seg-btn.delete:hover { background: var(--escalate); color: white; }

    /* Compact mode: hide normal buttons, show ⋮ trigger */
    .compact-btns .seg-controls { display: none; }
    .seg-menu-btn { display: none; }
    .compact-btns .seg-menu-btn { display: flex; }

    /* Overflow dropdown */
    .seg-dropdown {
      position: absolute; top: 30px; right: 0; z-index: 300;
      background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
      padding: 4px; display: flex; flex-direction: column; gap: 2px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6); min-width: 140px;
    }
    .seg-dropdown button {
      width: 100%; text-align: left; padding: 6px 10px; font-size: 12px;
      background: transparent; border: none; border-radius: 4px;
      color: var(--text); cursor: pointer; font-family: inherit;
    }
    .seg-dropdown button:hover { background: var(--border); }
    .seg-dropdown button.del:hover { background: var(--escalate); }

    .seg-title { width: 100%; background: transparent; border: none; font-size: calc(11px * var(--scale-t)); font-weight: 500; color: var(--text); font-family: inherit; margin-top: 4px; }
    .seg-title:focus { outline: none; background: var(--bg2); border-radius: 3px; padding: 2px; margin: 2px -2px; }
    .seg-desc { width: 100%; background: transparent; border: none; resize: none; font-size: calc(10px * var(--scale-t)); color: var(--dim); font-family: inherit; margin-top: 4px; min-height: calc(32px * var(--scale-h)); }
    .seg-desc:focus { outline: none; background: var(--bg2); border-radius: 3px; }
    .seg-notes { width: 100%; background: transparent; border: none; font-size: calc(9px * var(--scale-t)); color: var(--open-loop); font-style: italic; margin-top: 4px; font-family: inherit; }

    /* Wrap mode — textareas replace single-line inputs, all content visible */
    .seg-ta { width: 100%; background: transparent; border: none; resize: none; overflow: hidden; font-family: inherit; display: block; }
    .seg-ta:focus { outline: none; background: var(--bg2); border-radius: 3px; }
    .seg-title.seg-ta { font-size: calc(11px * var(--scale-t)); font-weight: 500; color: var(--text); margin-top: 4px; }
    .seg-notes.seg-ta { font-size: calc(9px * var(--scale-t)); color: var(--open-loop); font-style: italic; margin-top: 4px; }
    .wrap-mode .seg-desc { min-height: unset; overflow: hidden; resize: none; }
    .wrap-mode .seg { max-width: calc(180px * var(--scale-w)); }
    .btn-active { background: var(--hook) !important; border-color: var(--hook) !important; color: #fff !important; }

    .arrow { color: var(--dim); font-size: 12px; flex-shrink: 0; padding: 0 2px; }

    .drop-indicator {
      width: 3px; align-self: stretch; min-height: calc(60px * var(--scale-h));
      background: var(--hook); border-radius: 2px; flex-shrink: 0;
      animation: dropPulse 0.5s ease infinite alternate;
    }
    @keyframes dropPulse { from { opacity: 0.5; } to { opacity: 1; box-shadow: 0 0 6px var(--hook); } }

    .add-seg { min-width: 40px; height: calc(70px * var(--scale-h)); flex-shrink: 0; background: var(--bg2); border: 1px dashed var(--border); border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--dim); font-size: 18px; margin-left: 4px; }
    .add-seg:hover { border-color: var(--hook); color: var(--hook); }

    .empty, .loading { padding: 60px; text-align: center; color: var(--dim); }
    .empty h2, .loading h2 { font-size: 18px; margin-bottom: 12px; color: var(--text); }

    .clipboard-toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px; background: var(--payoff); color: #000; border-radius: 8px; font-size: 12px; font-weight: 500; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    .clipboard-toast.show { opacity: 1; }

    .seg.seg-selected { outline: 2px solid var(--hook); outline-offset: 1px; }

    @media (max-width: 768px) {
      .video-row { flex-direction: column; min-height: unset; }
      .video-info { width: 100%; min-width: unset; border-right: none; border-bottom: 1px solid var(--border); }
      .segments { min-height: 120px; }
      .scale-controls { display: none; }
    }

    @media print {
      @page { size: landscape; margin: 8mm; }
      .header, .filter-bar, .legend, .btn, .add-seg, .seg-controls, .seg-menu-btn, .clipboard-toast, .arrow { display: none !important; }
      body { background: white; color: #1a1a1a; font-size: 10px; }
      .videos { display: block; }
      .video-row { display: flex; align-items: flex-start; background: white !important; border-bottom: 1px solid #ccc; page-break-inside: avoid; min-height: unset !important; padding: 4px 0; }
      .video-row.hidden { display: none !important; }
      .video-info { width: 110px !important; min-width: 110px !important; padding: 4px 6px; font-size: 9px; }
      .video-title { font-size: 10px; }
      .video-hook { white-space: normal; font-size: 8px; }
      .segments { overflow: visible !important; flex-wrap: wrap; gap: 3px !important; padding: 4px 6px !important; align-items: flex-start; }
      .seg { min-width: 85px !important; max-width: 110px !important; padding: 4px !important; background: #f8f8f8 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; page-break-inside: avoid; }
      .seg-type { font-size: 7px !important; padding: 1px 3px; }
      /* hide real inputs; show .pf (print-field) divs instead */
      .seg-title, .seg-notes, .seg-desc { display: none !important; }
      .pf { display: block; word-wrap: break-word; white-space: pre-wrap; }
      .pf-title { font-size: 9px; font-weight: 600; color: #1a1a1a; margin-top: 3px; }
      .pf-desc { font-size: 8px; color: #555; margin-top: 2px; }
      .pf-notes { font-size: 7px; color: #c47c00; font-style: italic; margin-top: 2px; }
      .seg.seg-selected { outline: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📺 Beat Sheet Editor</h1>
    <span class="sync-status" id="syncStatus">Loading...</span>
    <span id="count" style="color: var(--dim)"></span>
    <div class="scale-controls">
      <label>W&nbsp;<span id="scaleWVal">100</span>%</label>
      <input type="range" min="25" max="600" value="100" id="scaleW" oninput="updateScale()">
      <label>H&nbsp;<span id="scaleHVal">100</span>%</label>
      <input type="range" min="25" max="600" value="100" id="scaleH" oninput="updateScale()">
      <label>T&nbsp;<span id="scaleTVal">100</span>%</label>
      <input type="range" min="25" max="300" value="100" id="scaleT" oninput="updateScale()">
    </div>
    <div class="header-actions">
      <button class="btn" id="undoBtn" onclick="undo()" disabled>↩ Undo</button>
      <button class="btn" id="redoBtn" onclick="redo()" disabled>↪ Redo</button>
      <button class="btn" id="wrapBtn" onclick="toggleWrap()">Wrap</button>
      <button class="btn btn-primary" onclick="pullFromNotion()">↓ Pull from Notion</button>
      <button class="btn btn-green" onclick="pushAllToNotion()">↑ Push All to Notion</button>
      <button class="btn" onclick="window.print()">🖨 Print</button>
    </div>
  </div>

  <div class="filter-bar">
    <label>Filter:</label>
    <select class="filter-select" id="statusFilter" onchange="applyFilter()"><option value="">All</option></select>
    <div class="status-counts" id="statusCounts"></div>
  </div>

  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background: var(--hook)"></div> Hook</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--open-loop)"></div> Open loop</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--loop-back)"></div> Loop back</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--payoff)"></div> Payoff</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--cta)"></div> CTA</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--body)"></div> Body</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--b-story)"></div> B-story</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--prepare)"></div> Prepare</div>
    <div class="legend-item"><div class="legend-dot" style="background: var(--purchase)"></div> Purchase</div>
  </div>

  <div id="videos" class="videos"><div class="loading"><h2>Loading from Notion...</h2></div></div>
  <div class="clipboard-toast" id="toast">Copied!</div>

<script>
let videos = [];
let clipboard = null;
let history = [];
let historyIndex = -1;
let selectedVi = null, selectedSi = null;
let lastHoveredVi = 0;
let wrapMode = false;
const TYPES = ['hook','intro','open-loop','loop-back','payoff','cta','body','test','escalate','wildcard','b-story','conclusion','prepare','purchase','stakes','comments'];

// ── History ────────────────────────────────────────────────
function saveHistory() {
  history = history.slice(0, historyIndex + 1);
  history.push(JSON.parse(JSON.stringify(videos)));
  if (history.length > 50) history = history.slice(history.length - 50);
  historyIndex = history.length - 1;
  updateUndoRedoBtns();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  videos = JSON.parse(JSON.stringify(history[historyIndex]));
  render();
  updateUndoRedoBtns();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  videos = JSON.parse(JSON.stringify(history[historyIndex]));
  render();
  updateUndoRedoBtns();
}

function updateUndoRedoBtns() {
  document.getElementById('undoBtn').disabled = historyIndex <= 0;
  document.getElementById('redoBtn').disabled = historyIndex >= history.length - 1;
}

document.addEventListener('keydown', e => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const inText = ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === 'z' && !inText) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
  if (e.key === 'c' && !inText && selectedVi !== null) {
    e.preventDefault();
    collectAll();
    clipboard = JSON.parse(JSON.stringify(videos[selectedVi].roadmap.segments[selectedSi]));
    showToast('Copied!');
  }
  if (e.key === 'v' && !inText && clipboard) {
    e.preventDefault();
    collectAll();
    const s = JSON.parse(JSON.stringify(clipboard));
    s.id = Date.now();
    videos[lastHoveredVi].roadmap.segments.push(s);
    saveHistory();
    render();
    showToast('Pasted!');
  }
});

// ── Scale controls ─────────────────────────────────────────
function updateScale() {
  const w = document.getElementById('scaleW').value / 100;
  const h = document.getElementById('scaleH').value / 100;
  const t = document.getElementById('scaleT').value / 100;
  document.getElementById('scaleWVal').textContent = Math.round(w * 100);
  document.getElementById('scaleHVal').textContent = Math.round(h * 100);
  document.getElementById('scaleTVal').textContent = Math.round(t * 100);
  document.documentElement.style.setProperty('--scale-w', w);
  document.documentElement.style.setProperty('--scale-h', h);
  document.documentElement.style.setProperty('--scale-t', t);
  localStorage.setItem('bs-scale-w', w);
  localStorage.setItem('bs-scale-h', h);
  localStorage.setItem('bs-scale-t', t);
  document.body.classList.toggle('compact-btns', w < 0.8);
}

function initScale() {
  const w = parseFloat(localStorage.getItem('bs-scale-w') || '1');
  const h = parseFloat(localStorage.getItem('bs-scale-h') || '1');
  const t = parseFloat(localStorage.getItem('bs-scale-t') || '1');
  document.getElementById('scaleW').value = Math.round(w * 100);
  document.getElementById('scaleH').value = Math.round(h * 100);
  document.getElementById('scaleT').value = Math.round(t * 100);
  document.getElementById('scaleWVal').textContent = Math.round(w * 100);
  document.getElementById('scaleHVal').textContent = Math.round(h * 100);
  document.getElementById('scaleTVal').textContent = Math.round(t * 100);
  document.documentElement.style.setProperty('--scale-w', w);
  document.documentElement.style.setProperty('--scale-h', h);
  document.documentElement.style.setProperty('--scale-t', t);
  document.body.classList.toggle('compact-btns', w < 0.8);
}

// ── Notion sync ────────────────────────────────────────────
async function pullFromNotion() {
  setStatus('syncing', 'Pulling...');
  try {
    const res = await fetch('/api/pull');
    if (!res.ok) throw new Error('Pull failed');
    videos = await res.json();
    buildFilter();
    render();
    history = [JSON.parse(JSON.stringify(videos))];
    historyIndex = 0;
    updateUndoRedoBtns();
    setStatus('saved', 'Loaded ' + videos.length + ' videos');
    setTimeout(() => setStatus('', 'Ready'), 2000);
  } catch (err) {
    setStatus('error', err.message);
  }
}

async function pushAllToNotion() {
  collectAll();
  setStatus('syncing', 'Pushing ' + videos.length + ' videos...');
  try {
    const res = await fetch('/api/push-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(videos)
    });
    if (!res.ok) throw new Error('Push failed');
    setStatus('saved', 'All saved to Notion!');
    setTimeout(() => setStatus('', 'Ready'), 2000);
  } catch (err) {
    setStatus('error', err.message);
  }
}

function setStatus(type, msg) {
  const el = document.getElementById('syncStatus');
  el.className = 'sync-status' + (type ? ' ' + type : '');
  el.textContent = msg;
}

function videoCharCount(v) {
  return (v.roadmap?.segments || []).reduce((n, s) =>
    n + (s.title||'').length + (s.desc||'').length + (s.notes||'').length, 0);
}
function updateCharCount(vi) {
  let n = 0;
  document.querySelectorAll('.video-row[data-vi="' + vi + '"] .seg-title, .video-row[data-vi="' + vi + '"] .seg-desc, .video-row[data-vi="' + vi + '"] .seg-notes')
    .forEach(el => n += (el.value || '').length);
  const el = document.getElementById('cc-' + vi);
  if (el) { el.textContent = n + '/2000'; el.style.color = n > 2000 ? 'var(--escalate)' : ''; }
}

function collectAll() {
  document.querySelectorAll('.video-row').forEach(row => {
    const vi = +row.dataset.vi;
    videos[vi].roadmap.segments = [];
    row.querySelectorAll('.seg').forEach(seg => {
      videos[vi].roadmap.segments.push({
        id: Date.now() + Math.random(),
        type: seg.dataset.type,
        title: seg.querySelector('.seg-title').value,
        desc: seg.querySelector('.seg-desc').value,
        notes: seg.querySelector('.seg-notes').value
      });
    });
  });
}

function buildFilter() {
  const statuses = [...new Set(videos.map(v => v.status || '(none)'))].sort();
  const sel = document.getElementById('statusFilter');
  sel.innerHTML = '<option value="">All (' + videos.length + ')</option>' + statuses.map(s => {
    const c = videos.filter(v => (v.status || '(none)') === s).length;
    return '<option value="' + esc(s) + '">' + esc(s) + ' (' + c + ')</option>';
  }).join('');
  document.getElementById('statusCounts').innerHTML = statuses.map(s => {
    const c = videos.filter(v => (v.status || '(none)') === s).length;
    return '<span class="status-count" onclick="document.getElementById(\\'statusFilter\\').value=\\'' + esc(s) + '\\';applyFilter()">' + esc(s) + ': ' + c + '</span>';
  }).join('');
}

function applyFilter() {
  const f = document.getElementById('statusFilter').value;
  document.querySelectorAll('.video-row').forEach(row => {
    row.classList.toggle('hidden', f && row.dataset.status !== f);
  });
  const vis = document.querySelectorAll('.video-row:not(.hidden)').length;
  document.getElementById('count').textContent = f ? vis + ' of ' + videos.length : videos.length + ' videos';
}

// ── Render ─────────────────────────────────────────────────
function render() {
  const c = document.getElementById('videos');
  if (!videos.length) { c.innerHTML = '<div class="empty"><h2>No videos</h2><p>Make sure some cards have "Beat Sheetin" checked</p></div>'; return; }
  c.innerHTML = videos.map((v, vi) =>
    '<div class="video-row" data-vi="' + vi + '" data-status="' + esc(v.status || '(none)') + '">' +
      '<div class="video-info">' +
        '<div class="video-meta"><span class="video-num">#' + (vi + 1) + '</span><span class="video-status">' + esc(v.status || '-') + '</span></div>' +
        '<input class="video-title" value="' + esc(v.title) + '" placeholder="Title...">' +
        '<div class="video-info-row">' +
          (v.videoUrl ? '<a class="url-btn" href="' + esc(v.videoUrl) + '" target="_blank" rel="noopener">URL</a>' : '<span class="url-btn" style="opacity:0.4;cursor:default">no url</span>') +
          '<span class="char-count" id="cc-' + vi + '"' + (videoCharCount(v) > 2000 ? ' style="color:var(--escalate)"' : '') + '>' + videoCharCount(v) + '/2000</span>' +
        '</div>' +
        '<div class="video-hook">' + esc(v.hook || 'No hook') + '</div>' +
      '</div>' +
      '<div class="segments" data-vi="' + vi + '">' +
        (v.roadmap?.segments || []).map((s, si) => renderSeg(vi, si, s)).join('<span class="arrow">→</span>') +
        '<div class="add-seg" onclick="addSeg(' + vi + ')">+</div>' +
      '</div>' +
    '</div>'
  ).join('');
  applyFilter();
  setupDrag();
  setupCardSelect();
  setupHoverTracking();
  if (wrapMode) setupWrapResize();
}

function renderSeg(vi, si, s) {
  const titleHtml = wrapMode
    ? '<textarea class="seg-title seg-ta" placeholder="Title..." oninput="autoResize(this);updateCharCount(' + vi + ')">' + esc(s.title) + '</textarea>'
    : '<input class="seg-title" value="' + esc(s.title) + '" placeholder="Title..." oninput="updateCharCount(' + vi + ')">';
  const notesHtml = wrapMode
    ? '<textarea class="seg-notes seg-ta" placeholder="Notes..." oninput="autoResize(this);updateCharCount(' + vi + ')">' + esc(s.notes) + '</textarea>'
    : '<input class="seg-notes" value="' + esc(s.notes) + '" placeholder="Notes..." oninput="updateCharCount(' + vi + ')">';
  return '<div class="seg ' + s.type + '" data-type="' + s.type + '" data-vi="' + vi + '" data-si="' + si + '" draggable="true">' +
    '<div class="seg-header">' +
      '<select class="seg-type" onchange="chgType(this)">' +
        TYPES.map(t => '<option value="' + t + '"' + (t === s.type ? ' selected' : '') + '>' + t.replace(/-/g,' ').toUpperCase() + '</option>').join('') +
      '</select>' +
      '<div class="seg-controls">' +
        '<button class="seg-btn" onclick="moveSeg(' + vi + ',' + si + ',-1)" title="Left">←</button>' +
        '<button class="seg-btn" onclick="moveSeg(' + vi + ',' + si + ',1)" title="Right">→</button>' +
        '<button class="seg-btn" onclick="copySeg(' + vi + ',' + si + ')" title="Copy">⎘</button>' +
        '<button class="seg-btn" onclick="pasteSeg(' + vi + ',' + si + ')" title="Paste">⎗</button>' +
        '<button class="seg-btn delete" onclick="delSeg(' + vi + ',' + si + ')" title="Delete">×</button>' +
      '</div>' +
      '<button class="seg-btn seg-menu-btn" onclick="toggleMenu(this,event,' + vi + ',' + si + ')" title="Actions">⋮</button>' +
    '</div>' +
    titleHtml +
    '<textarea class="seg-desc" placeholder="Description..."' + (wrapMode ? ' oninput="autoResize(this);updateCharCount(' + vi + ')"' : ' oninput="updateCharCount(' + vi + ')"') + '>' + esc(s.desc) + '</textarea>' +
    notesHtml +
  '</div>';
}

// ── Compact overflow menu ──────────────────────────────────
function toggleMenu(btn, e, vi, si) {
  e.stopPropagation();
  const seg = btn.closest('.seg');
  const existing = seg.querySelector('.seg-dropdown');
  closeMenus();
  if (existing) return;
  const m = document.createElement('div');
  m.className = 'seg-dropdown';
  m.innerHTML =
    '<button onclick="moveSeg(' + vi + ',' + si + ',-1);closeMenus()">← Move Left</button>' +
    '<button onclick="moveSeg(' + vi + ',' + si + ',1);closeMenus()">→ Move Right</button>' +
    '<button onclick="copySeg(' + vi + ',' + si + ');closeMenus()">⎘ Copy</button>' +
    '<button onclick="pasteSeg(' + vi + ',' + si + ');closeMenus()">⎗ Paste</button>' +
    '<button class="del" onclick="delSeg(' + vi + ',' + si + ')">× Delete</button>';
  seg.appendChild(m);
}

function closeMenus() {
  document.querySelectorAll('.seg-dropdown').forEach(m => m.remove());
}

function setupCardSelect() {
  document.querySelectorAll('.seg').forEach(seg => {
    seg.addEventListener('click', e => {
      if (e.target.closest('button, input, textarea, select')) return;
      document.querySelectorAll('.seg').forEach(s => s.classList.remove('seg-selected'));
      seg.classList.add('seg-selected');
      selectedVi = +seg.dataset.vi;
      selectedSi = +seg.dataset.si;
    });
  });
}

function setupHoverTracking() {
  document.querySelectorAll('.segments').forEach(container => {
    container.addEventListener('mouseover', () => { lastHoveredVi = +container.dataset.vi; });
  });
}

document.addEventListener('click', e => {
  closeMenus();
  if (!e.target.closest('.seg')) {
    document.querySelectorAll('.seg').forEach(s => s.classList.remove('seg-selected'));
    selectedVi = null;
    selectedSi = null;
  }
});

// ── Card mutations ─────────────────────────────────────────
function chgType(sel) {
  const seg = sel.closest('.seg');
  TYPES.forEach(t => seg.classList.remove(t));
  seg.classList.add(sel.value);
  seg.dataset.type = sel.value;
  collectAll();
  saveHistory();
}

function addSeg(vi) {
  collectAll();
  videos[vi].roadmap.segments.push({ id: Date.now(), type: 'body', title: '', desc: '', notes: '' });
  saveHistory();
  render();
}

function delSeg(vi, si) {
  collectAll();
  videos[vi].roadmap.segments.splice(si, 1);
  saveHistory();
  render();
}

function moveSeg(vi, si, dir) {
  collectAll();
  const segs = videos[vi].roadmap.segments;
  const np = si + dir;
  if (np < 0 || np >= segs.length) return;
  const [s] = segs.splice(si, 1);
  segs.splice(np, 0, s);
  saveHistory();
  render();
}

function copySeg(vi, si) {
  collectAll();
  clipboard = JSON.parse(JSON.stringify(videos[vi].roadmap.segments[si]));
  showToast('Copied!');
}

function pasteSeg(vi, si) {
  if (!clipboard) return;
  collectAll();
  const s = JSON.parse(JSON.stringify(clipboard));
  s.id = Date.now();
  videos[vi].roadmap.segments.splice(si + 1, 0, s);
  saveHistory();
  render();
  showToast('Pasted!');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1500);
}

// ── Drag & Drop ────────────────────────────────────────────
function setupDrag() {
  let dragData = null;

  function calcDropIndex(container, clientX) {
    const segs = [...container.querySelectorAll('.seg:not(.dragging)')];
    for (let i = 0; i < segs.length; i++) {
      const r = segs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return segs.length;
  }

  function showDropIndicator(container, index) {
    clearDropIndicators();
    const ind = document.createElement('div');
    ind.className = 'drop-indicator';
    const segs = [...container.querySelectorAll('.seg:not(.dragging)')];
    if (!segs.length || index >= segs.length) {
      container.insertBefore(ind, container.querySelector('.add-seg') || null);
    } else {
      // Insert before any arrow that precedes segs[index]
      const prev = segs[index].previousSibling;
      const before = (prev && prev.classList && prev.classList.contains('arrow')) ? prev : segs[index];
      container.insertBefore(ind, before);
    }
  }

  function clearDropIndicators() {
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  }

  document.querySelectorAll('.seg').forEach(seg => {
    seg.ondragstart = e => {
      dragData = { vi: +seg.dataset.vi, si: +seg.dataset.si };
      seg.classList.add('dragging');
      e.dataTransfer.setData('text/plain', JSON.stringify(dragData));
      e.dataTransfer.effectAllowed = 'move';
    };
    seg.ondragend = () => {
      seg.classList.remove('dragging');
      clearDropIndicators();
      dragData = null;
    };
  });

  document.querySelectorAll('.segments').forEach(container => {
    container.ondragover = e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showDropIndicator(container, calcDropIndex(container, e.clientX));
    };
    container.ondragleave = e => {
      if (!container.contains(e.relatedTarget)) clearDropIndicators();
    };
    container.ondrop = e => {
      e.preventDefault();
      if (!dragData) return;
      const toVi = +container.dataset.vi;
      let toSi = calcDropIndex(container, e.clientX);
      clearDropIndicators();
      collectAll();
      const [moved] = videos[dragData.vi].roadmap.segments.splice(dragData.si, 1);
      videos[toVi].roadmap.segments.splice(toSi, 0, moved);
      saveHistory();
      render();
    };
  });
}

// ── Wrap mode ──────────────────────────────────────────────
function toggleWrap() {
  wrapMode = !wrapMode;
  document.getElementById('wrapBtn').classList.toggle('btn-active', wrapMode);
  collectAll();
  render();
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function setupWrapResize() {
  document.querySelectorAll('.seg-ta, .seg-desc').forEach(el => {
    autoResize(el);
    el.addEventListener('input', () => autoResize(el));
  });
}

// ── Print helpers ──────────────────────────────────────────
window.addEventListener('beforeprint', () => {
  collectAll();
  document.querySelectorAll('.seg').forEach(seg => {
    const vi = seg.dataset.vi, si = seg.dataset.si;
    if (vi === undefined) return;
    const titleEl = seg.querySelector('.seg-title');
    const descEl  = seg.querySelector('.seg-desc');
    const notesEl = seg.querySelector('.seg-notes');
    const mk = (cls, val) => { const d = document.createElement('div'); d.className = 'pf ' + cls; d.textContent = val || ''; seg.appendChild(d); };
    mk('pf-title', titleEl ? titleEl.value : '');
    mk('pf-desc',  descEl  ? descEl.value  : '');
    mk('pf-notes', notesEl ? notesEl.value : '');
  });
});
window.addEventListener('afterprint', () => {
  document.querySelectorAll('.pf').forEach(el => el.remove());
});

function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }

initScale();
pullFromNotion();
</script>
</body>
</html>`;
}
