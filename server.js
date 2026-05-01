// server.js — Beat Sheet Editor with Notion sync + Cloudflare R2 media
// Run: node server.js   →   http://localhost:3456

const http = require('http');
const { Client } = require('@notionhq/client');

// Load .env for local dev
try {
  require('fs').readFileSync(__dirname + '/.env', 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) { const k = line.slice(0, eq).trim(); const v = line.slice(eq + 1).trim(); if (k && !process.env[k]) process.env[k] = v; }
  });
} catch {}

// ============================================================
// CONFIG
// ============================================================
const PORT    = 3456;
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const DATABASE_ID   = process.env.NOTION_DATABASE_ID;

const FIELD_TITLE        = 'Idea';
const FIELD_HOOK         = 'Hook';
const FIELD_BEATSHEET    = 'Beat Sheet';
const FIELD_MEDIA_INDEX  = 'Media Index';
const FIELD_BEAT_SHEETIN = 'Beat Sheetin';
const FIELD_STATUS       = 'Status';

const notion = new Client({ auth: NOTION_TOKEN });

// ── Rich-text chunk helpers ──────────────────────────────────
function fromRichText(arr) {
  return (arr || []).map(r => r.plain_text || '').join('');
}
function toRichText(str) {
  const chunks = [];
  for (let i = 0; i < str.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: str.slice(i, i + 2000) } });
  }
  if (!chunks.length) chunks.push({ type: 'text', text: { content: '' } });
  return chunks;
}

// ── R2 client (lazy — only if env vars are present) ──────────
let _s3 = null;
function getR2() {
  if (_s3) return _s3;
  if (!process.env.CLOUDFLARE_R2_ACCOUNT_ID) return null;
  const { S3Client } = require('@aws-sdk/client-s3');
  _s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    },
  });
  return _s3;
}

// ============================================================
// NOTION API
// ============================================================
async function pullVideos() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { property: FIELD_BEAT_SHEETIN, checkbox: { equals: true } },
    page_size: 100
  });

  return response.results.map(page => {
    const p = page.properties;
    const title  = p[FIELD_TITLE]?.title?.[0]?.plain_text || '';
    const hook   = p[FIELD_HOOK]?.rich_text?.[0]?.plain_text || '';
    const status = p[FIELD_STATUS]?.status?.name || p[FIELD_STATUS]?.select?.name || '';

    const raw = fromRichText(p[FIELD_BEATSHEET]?.rich_text);
    let roadmap;
    try { roadmap = raw ? JSON.parse(raw) : null; } catch { roadmap = null; }
    if (!roadmap) {
      roadmap = {
        segments: [
          { id: 1, type: 'hook',      title: hook || '', desc: '', notes: '' },
          { id: 2, type: 'open-loop', title: '',         desc: '', notes: '' },
          { id: 3, type: 'body',      title: '',         desc: '', notes: '' },
          { id: 4, type: 'payoff',    title: '',         desc: '', notes: '' },
          { id: 5, type: 'cta',       title: '',         desc: '', notes: '' }
        ]
      };
    }

    const rawMedia = fromRichText(p[FIELD_MEDIA_INDEX]?.rich_text);
    let mediaIndex = [];
    try { mediaIndex = rawMedia ? JSON.parse(rawMedia) : []; } catch { mediaIndex = []; }

    const videoUrl = p['URL']?.url || '';
    return { id: page.id, url: page.url, videoUrl, title, hook, status, roadmap, mediaIndex };
  });
}

async function pushVideo(video) {
  await notion.pages.update({
    page_id: video.id,
    properties: {
      [FIELD_BEATSHEET]: { rich_text: toRichText(JSON.stringify(video.roadmap)) }
    }
  });
}

async function pushVideosParallel(videos) {
  const CONCURRENCY = 3;
  for (let i = 0; i < videos.length; i += CONCURRENCY) {
    await Promise.all(videos.slice(i, i + CONCURRENCY).map(v => pushVideo(v)));
  }
}

// ============================================================
// SERVER
// ============================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // ── Pull ──────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/api/pull') {
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

  // ── Push-all ──────────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/push-all') {
    try {
      const videos = await readBody(req);
      await pushVideosParallel(videos);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Upload URL (presigned) ────────────────────────────────
  if (req.method === 'POST' && url === '/api/upload-url') {
    if (!process.env.CLOUDFLARE_R2_ACCOUNT_ID) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'R2 not configured. Add CLOUDFLARE_R2_* env vars.' }));
    }
    try {
      const { notion_id, filename, kind } = await readBody(req);
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const MIME = { image: 'image/png', audio: 'audio/webm', video: 'video/mp4' };
      const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'bin';
      const uid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const r2_key = `${notion_id}/${uid}.${ext}`;
      const uploadUrl = await getSignedUrl(getR2(), new PutObjectCommand({
        Bucket: process.env.CLOUDFLARE_R2_BUCKET, Key: r2_key,
        ContentType: MIME[kind] || 'application/octet-stream'
      }), { expiresIn: 3600 });
      const publicUrl = `${process.env.CLOUDFLARE_R2_PUBLIC_URL}/${r2_key}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uploadUrl, publicUrl, r2_key }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Confirm upload ────────────────────────────────────────
  if (req.method === 'POST' && url === '/api/confirm-upload') {
    try {
      const { notion_id, r2_key, public_url, kind, filename, description } = await readBody(req);
      const blockType = kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'image';
      let block_id = 'unknown';
      try {
        const br = await notion.blocks.children.append({
          block_id: notion_id,
          children: [{ type: blockType, [blockType]: { type: 'external', external: { url: public_url } } }]
        });
        block_id = br.results?.[0]?.id || 'unknown';
      } catch {}

      const page = await notion.pages.retrieve({ page_id: notion_id });
      const existing = fromRichText(page.properties[FIELD_MEDIA_INDEX]?.rich_text);
      let mediaIndex = [];
      try { mediaIndex = existing ? JSON.parse(existing) : []; } catch {}
      mediaIndex.push({ r2_key, block_id, kind, filename: filename || '', description: description || '', public_url });
      await notion.pages.update({
        page_id: notion_id,
        properties: { [FIELD_MEDIA_INDEX]: { rich_text: toRichText(JSON.stringify(mediaIndex)) } }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, block_id, public_url }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Delete media ──────────────────────────────────────────
  if (req.method === 'DELETE' && url === '/api/delete-media') {
    try {
      const { notion_id, r2_key, block_id } = await readBody(req);
      const r2 = getR2();
      if (r2) {
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        try { await r2.send(new DeleteObjectCommand({ Bucket: process.env.CLOUDFLARE_R2_BUCKET, Key: r2_key })); } catch {}
      }
      if (block_id && block_id !== 'unknown') {
        try { await notion.blocks.delete({ block_id }); } catch {}
      }
      const page = await notion.pages.retrieve({ page_id: notion_id });
      const existing = fromRichText(page.properties[FIELD_MEDIA_INDEX]?.rich_text);
      let mediaIndex = [];
      try { mediaIndex = existing ? JSON.parse(existing) : []; } catch {}
      mediaIndex = mediaIndex.filter(m => m.r2_key !== r2_key);
      await notion.pages.update({
        page_id: notion_id,
        properties: { [FIELD_MEDIA_INDEX]: { rich_text: toRichText(JSON.stringify(mediaIndex)) } }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── HTML ──────────────────────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getHTML());
});

server.listen(PORT, () => {
  console.log('');
  console.log('Beat Sheet Editor running at http://localhost:' + PORT);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');
});

// ============================================================
// HTML
// ============================================================
function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Beat Sheet Editor</title>
  <!-- tui-image-editor (includes fabric.js + color-picker in bundle) -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tui-image-editor@3.15.4/dist/tui-image-editor.min.css">
  <!-- QR code generator for print -->
  <script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
  <style>
    :root {
      --bg: #0d0d12; --bg2: #16161e; --bg3: #1e1e28; --border: #2a2a3a;
      --text: #e8e8ed; --dim: #6b6b80;
      --hook: #3b82f6; --intro: #06b6d4; --open-loop: #f59e0b; --loop-back: #ea580c;
      --payoff: #22c55e; --cta: #a855f7; --body: #6366f1; --test: #64748b;
      --escalate: #ef4444; --wildcard: #ec4899; --b-story: #14b8a6; --conclusion: #8b5cf6;
      --prepare: #f97316; --purchase: #10b981; --stakes: #f43f5e; --comments: #94a3b8;
      --scale-w: 1; --scale-h: 1; --scale-t: 1;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); font-size: 13px; }

    /* ── Header ─────────────────────────────────────────────── */
    .header {
      position: sticky; top: 0; z-index: 100; background: var(--bg);
      border-bottom: 1px solid var(--border); padding: 12px 16px;
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .header h1 { font-size: 16px; font-weight: 600; }
    .sync-status { font-size: 11px; padding: 4px 10px; border-radius: 10px; background: var(--bg3); color: var(--dim); }
    .sync-status.syncing { background: var(--open-loop); color: #000; }
    .sync-status.saved   { background: var(--payoff); color: #000; }
    .sync-status.error   { background: var(--escalate); color: #fff; }
    .header-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .btn { padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg2); color: var(--text); font-size: 12px; font-weight: 500; cursor: pointer; }
    .btn:hover { border-color: var(--dim); }
    .btn:disabled { opacity: 0.35; cursor: default; pointer-events: none; }
    .btn-primary { background: var(--hook); border-color: var(--hook); color: #fff; }
    .btn-green   { background: var(--payoff); border-color: var(--payoff); color: #000; }
    .btn-active  { background: var(--hook) !important; border-color: var(--hook) !important; color: #fff !important; }

    .scale-controls { display: flex; align-items: center; gap: 8px; }
    .scale-controls label { font-size: 11px; color: var(--dim); white-space: nowrap; }
    .scale-controls input[type=range] { width: 80px; accent-color: var(--hook); cursor: pointer; }

    /* ── Filter / Legend ─────────────────────────────────────── */
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

    /* ── Video rows ──────────────────────────────────────────── */
    .videos { display: flex; flex-direction: column; }

    .video-row {
      display: flex; flex-direction: column;
      border-bottom: 1px solid var(--border);
      background: var(--bg2);
    }
    .video-row:nth-child(odd) { background: var(--bg); }
    .video-row:hover { background: var(--bg3); }
    .video-row.hidden { display: none; }

    .video-row-main {
      display: flex; align-items: stretch;
      min-height: calc(90px * var(--scale-h));
    }

    .video-info { width: 200px; min-width: 200px; padding: 10px 12px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
    .video-meta { display: flex; align-items: center; gap: 8px; }
    .video-num { font-size: 10px; font-weight: 700; color: var(--dim); font-family: monospace; }
    .video-status { font-size: 9px; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: 10px; background: var(--bg3); color: var(--dim); }
    .video-title { font-size: 13px; font-weight: 600; color: var(--text); background: transparent; border: none; width: 100%; font-family: inherit; }
    .video-title:focus { outline: none; background: var(--bg3); border-radius: 3px; padding: 2px 4px; margin: -2px -4px; }
    .video-hook { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .video-info-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .url-btn { display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; background: var(--bg3); border: 1px solid var(--border); border-radius: 5px; color: var(--dim); font-size: 11px; font-weight: 700; text-decoration: none; letter-spacing: 0.05em; }
    .url-btn:hover { border-color: var(--hook); color: var(--hook); }
    .char-count { font-size: 10px; color: var(--dim); }

    /* ── Segments ────────────────────────────────────────────── */
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
    .seg.hook      { border-color: var(--hook); }
    .seg.intro     { border-color: var(--intro); }
    .seg.open-loop { border-color: var(--open-loop); background: linear-gradient(90deg, rgba(245,158,11,0.12) 0%, var(--bg3) 100%); }
    .seg.loop-back { border-color: var(--loop-back); background: linear-gradient(90deg, rgba(234,88,12,0.12) 0%, var(--bg3) 100%); }
    .seg.payoff    { border-color: var(--payoff); background: linear-gradient(90deg, rgba(34,197,94,0.12) 0%, var(--bg3) 100%); }
    .seg.cta       { border-color: var(--cta); }
    .seg.body      { border-color: var(--body); }
    .seg.test      { border-color: var(--test); }
    .seg.escalate  { border-color: var(--escalate); }
    .seg.wildcard  { border-color: var(--wildcard); }
    .seg.b-story   { border-color: var(--b-story); background: linear-gradient(90deg, rgba(20,184,166,0.12) 0%, var(--bg3) 100%); }
    .seg.conclusion { border-color: var(--conclusion); }
    .seg.prepare   { border-color: var(--prepare); background: linear-gradient(90deg, rgba(249,115,22,0.12) 0%, var(--bg3) 100%); }
    .seg.purchase  { border-color: var(--purchase); background: linear-gradient(90deg, rgba(16,185,129,0.12) 0%, var(--bg3) 100%); }
    .seg.stakes    { border-color: var(--stakes); background: linear-gradient(90deg, rgba(244,63,94,0.12) 0%, var(--bg3) 100%); }
    .seg.comments  { border-color: var(--comments); }

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

    .compact-btns .seg-controls { display: none; }
    .seg-menu-btn { display: none; }
    .compact-btns .seg-menu-btn { display: flex; }

    .seg-dropdown {
      position: absolute; top: 30px; right: 0; z-index: 300;
      background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
      padding: 4px; display: flex; flex-direction: column; gap: 2px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6); min-width: 140px;
    }
    .seg-dropdown button { width: 100%; text-align: left; padding: 6px 10px; font-size: 12px; background: transparent; border: none; border-radius: 4px; color: var(--text); cursor: pointer; font-family: inherit; }
    .seg-dropdown button:hover { background: var(--border); }
    .seg-dropdown button.del:hover { background: var(--escalate); }

    .seg-title  { width: 100%; background: transparent; border: none; font-size: calc(11px * var(--scale-t)); font-weight: 500; color: var(--text); font-family: inherit; margin-top: 4px; }
    .seg-title:focus { outline: none; background: var(--bg2); border-radius: 3px; padding: 2px; margin: 2px -2px; }
    .seg-desc   { width: 100%; background: transparent; border: none; resize: none; font-size: calc(10px * var(--scale-t)); color: var(--dim); font-family: inherit; margin-top: 4px; rows: 3; }
    .seg-desc:focus { outline: none; background: var(--bg2); border-radius: 3px; }
    .seg-notes  { width: 100%; background: transparent; border: none; font-size: calc(9px * var(--scale-t)); color: var(--open-loop); font-style: italic; margin-top: 4px; font-family: inherit; }

    /* Wrap mode */
    .seg-ta { width: 100%; background: transparent; border: none; resize: none; overflow: hidden; font-family: inherit; display: block; }
    .seg-ta:focus { outline: none; background: var(--bg2); border-radius: 3px; }
    .seg-title.seg-ta { font-size: calc(11px * var(--scale-t)); font-weight: 500; color: var(--text); margin-top: 4px; }
    .seg-notes.seg-ta { font-size: calc(9px * var(--scale-t)); color: var(--open-loop); font-style: italic; margin-top: 4px; }
    .wrap-mode .seg-desc { min-height: unset; overflow: hidden; resize: none; }
    .wrap-mode .seg { max-width: calc(180px * var(--scale-w)); }

    .arrow { color: var(--dim); font-size: 12px; flex-shrink: 0; padding: 0 2px; }
    .drop-indicator { width: 3px; align-self: stretch; min-height: calc(60px * var(--scale-h)); background: var(--hook); border-radius: 2px; flex-shrink: 0; animation: dropPulse 0.5s ease infinite alternate; }
    @keyframes dropPulse { from { opacity: 0.5; } to { opacity: 1; box-shadow: 0 0 6px var(--hook); } }
    .add-seg { min-width: 40px; height: calc(70px * var(--scale-h)); flex-shrink: 0; background: var(--bg2); border: 1px dashed var(--border); border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--dim); font-size: 18px; margin-left: 4px; }
    .add-seg:hover { border-color: var(--hook); color: var(--hook); }
    .seg.seg-selected { outline: 2px solid var(--hook); outline-offset: 1px; }

    /* ── Media panel ─────────────────────────────────────────── */
    .media-panel { border-top: 1px solid var(--border); background: var(--bg); }
    .mp-header {
      display: flex; align-items: center; gap: 10px; padding: 6px 12px;
      cursor: pointer; user-select: none; font-size: 12px; color: var(--dim);
    }
    .mp-header:hover { background: var(--bg2); }
    .mp-arrow { font-size: 10px; width: 12px; flex-shrink: 0; }
    .mp-label { font-weight: 600; color: var(--text); }
    .mp-count { font-size: 11px; color: var(--dim); }
    .mp-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
    .mp-btn { padding: 4px 10px; font-size: 11px; border-radius: 5px; }
    .mp-btn-record { background: transparent; border-color: var(--escalate); color: var(--escalate); }
    .mp-btn-record.recording { background: var(--escalate); color: #fff; }

    .mp-body { display: none; flex-wrap: wrap; gap: 10px; padding: 10px 14px; align-items: flex-start; }
    .mp-body.open { display: flex; }

    .mp-item { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; max-width: 200px; }
    .mp-item-audio { flex-direction: row; align-items: center; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; max-width: 300px; }
    .mp-item-video { max-width: 220px; }
    .mp-thumb { max-height: 120px; max-width: 180px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; object-fit: cover; }
    .mp-thumb:hover { border-color: var(--hook); }
    .mp-filename { font-size: 10px; color: var(--dim); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: 6px; }
    .mp-vid-desc { font-size: 10px; color: var(--dim); max-width: 200px; margin-top: 2px; }
    .mp-del { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; background: var(--escalate); color: #fff; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; }
    .mp-del:hover { background: #c00; }
    .mp-empty { font-size: 11px; color: var(--dim); padding: 4px 0; }

    /* ── Misc ────────────────────────────────────────────────── */
    .empty, .loading { padding: 60px; text-align: center; color: var(--dim); }
    .empty h2, .loading h2 { font-size: 18px; margin-bottom: 12px; color: var(--text); }
    .clipboard-toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px; background: var(--payoff); color: #000; border-radius: 8px; font-size: 12px; font-weight: 500; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    .clipboard-toast.show { opacity: 1; }

    /* ── Recording indicator ─────────────────────────────────── */
    #rec-indicator {
      display: none; position: fixed; bottom: 60px; right: 20px; z-index: 500;
      background: var(--escalate); color: #fff; padding: 10px 16px; border-radius: 8px;
      font-size: 12px; font-weight: 600; gap: 12px; align-items: center;
    }
    #rec-indicator.show { display: flex; }
    #rec-stop { padding: 4px 10px; border: 2px solid rgba(255,255,255,0.6); border-radius: 5px; background: transparent; color: #fff; cursor: pointer; font-size: 12px; }
    #rec-stop:hover { background: rgba(255,255,255,0.2); }

    /* ── Image editor modal ──────────────────────────────────── */
    #editor-modal {
      display: none; position: fixed; inset: 0; z-index: 1000;
      background: rgba(0,0,0,0.85); align-items: center; justify-content: center;
      padding: 20px;
    }
    #editor-modal.open { display: flex; }
    .editor-wrap { background: #2b2b38; border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 95vw; }
    #tui-editor-container { width: min(1100px, 90vw); height: min(600px, 70vh); }
    .editor-footer { display: flex; justify-content: flex-end; gap: 10px; }

    /* ── Mobile ──────────────────────────────────────────────── */
    @media (max-width: 768px) {
      .video-row-main { flex-direction: column; min-height: unset; }
      .video-info { width: 100%; min-width: unset; border-right: none; border-bottom: 1px solid var(--border); }
      .segments { min-height: 120px; }
      .scale-controls { display: none; }
    }

    /* ── Print ───────────────────────────────────────────────── */
    @media print {
      @page { size: landscape; margin: 10mm; }

      .header, .filter-bar, .legend, .btn, .add-seg,
      .seg-controls, .seg-menu-btn, .clipboard-toast,
      .arrow, .char-count, .media-panel,
      #rec-indicator, #editor-modal { display: none !important; }

      body { background: white; color: #111; font-size: 11px; }
      .videos { display: block; }

      .video-row {
        border: 1.5px solid #ccc; border-radius: 6px;
        page-break-inside: avoid; break-inside: avoid;
        margin-bottom: 8mm; background: white !important;
      }
      .video-row.hidden { display: none !important; }

      .video-row-main { display: flex; align-items: flex-start; }

      .video-info {
        width: 150px !important; min-width: 150px !important;
        padding: 8px 10px; font-size: 10px;
        border-right: 1px solid #ddd; border-radius: 6px 0 0 6px;
      }
      .video-title { font-size: 12px; font-weight: 700; color: #111; }
      .video-hook  { white-space: normal; font-size: 9px; color: #555; margin-top: 4px; }
      .print-qr    { margin-top: 8px; line-height: 0; }

      .segments {
        overflow: visible !important; flex-wrap: wrap;
        gap: 5px !important; padding: 6px 8px !important;
        align-items: flex-start;
      }

      .seg {
        min-width: 110px !important; max-width: 155px !important;
        padding: 6px !important; background: #f8f8f8 !important;
        border-radius: 5px; border-width: 2px !important;
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
        page-break-inside: avoid; break-inside: avoid;
      }
      .seg-type { font-size: 7px !important; padding: 1px 3px; }

      .seg-title, .seg-notes, .seg-desc { display: none !important; }
      .pf { display: block; word-wrap: break-word; overflow-wrap: break-word; white-space: pre-wrap; }
      .pf-type  { font-size: 7px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #888; margin-bottom: 2px; }
      .pf-title { font-size: 10px; font-weight: 700; color: #111; margin-top: 2px; line-height: 1.3; }
      .pf-desc  { font-size: 9px; color: #333; margin-top: 3px; line-height: 1.4; }
      .pf-notes { font-size: 8px; color: #b06000; font-style: italic; margin-top: 2px; }
      .seg.seg-selected { outline: none; }
    }
  </style>
</head>
<body>

<div class="header">
  <h1>&#127926; Beat Sheet Editor</h1>
  <span class="sync-status" id="syncStatus">Loading...</span>
  <span id="count" style="color: var(--dim)"></span>
  <div class="scale-controls">
    <label>W&nbsp;<span id="scaleWVal">100</span>%</label>
    <input type="range" min="25" max="600" value="100" id="scaleW" oninput="updateScale()">
    <label>H&nbsp;<span id="scaleHVal">100</span>%</label>
    <input type="range" min="25" max="600" value="100" id="scaleH" oninput="updateScale()">
    <label>T&nbsp;<span id="scaleTVal">100</span>%</label>
    <input type="range" min="25" max="600" value="100" id="scaleT" oninput="updateScale()">
  </div>
  <div class="header-actions">
    <button class="btn" id="undoBtn" onclick="undo()" disabled>&#8617; Undo</button>
    <button class="btn" id="redoBtn" onclick="redo()" disabled>&#8618; Redo</button>
    <button class="btn" id="wrapBtn" onclick="toggleWrap()">Wrap</button>
    <button class="btn btn-primary" onclick="pullFromNotion()">&#8595; Pull from Notion</button>
    <button class="btn btn-green"   onclick="pushAllToNotion()">&#8593; Push All to Notion</button>
    <button class="btn"             onclick="window.print()">&#128424; Print</button>
  </div>
</div>

<div class="filter-bar">
  <label>Filter:</label>
  <select class="filter-select" id="statusFilter" onchange="applyFilter()"><option value="">All</option></select>
  <div class="status-counts" id="statusCounts"></div>
</div>

<div class="legend">
  <div class="legend-item"><div class="legend-dot" style="background:var(--hook)"></div> Hook</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--open-loop)"></div> Open loop</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--loop-back)"></div> Loop back</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--payoff)"></div> Payoff</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--cta)"></div> CTA</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--body)"></div> Body</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--b-story)"></div> B-story</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--prepare)"></div> Prepare</div>
  <div class="legend-item"><div class="legend-dot" style="background:var(--purchase)"></div> Purchase</div>
</div>

<div id="videos" class="videos"><div class="loading"><h2>Loading from Notion...</h2></div></div>
<div class="clipboard-toast" id="toast">Copied!</div>

<!-- Recording indicator -->
<div id="rec-indicator">
  <span>&#9210; Recording</span>
  <button id="rec-stop" onclick="stopRecord()">&#9209; Stop</button>
</div>

<!-- Image/drawing editor modal -->
<div id="editor-modal">
  <div class="editor-wrap">
    <div id="tui-editor-container"></div>
    <div class="editor-footer">
      <button class="btn" onclick="cancelEditor()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditor()">Save &amp; Upload</button>
    </div>
  </div>
</div>

<script>
let videos = [];
let clipboard = null;
let history = [];
let historyIndex = -1;
let selectedVi = null, selectedSi = null;
let lastHoveredVi = 0;
let wrapMode = false;
const TYPES = ['hook','intro','open-loop','loop-back','payoff','cta','body','test','escalate','wildcard','b-story','conclusion','prepare','purchase','stakes','comments'];

// ── History ─────────────────────────────────────────────────
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
  if (e.key === 'z' && !inText) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
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

// ── Scale controls ───────────────────────────────────────────
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

// ── Notion sync ──────────────────────────────────────────────
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
  } catch (err) { setStatus('error', err.message); }
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
  } catch (err) { setStatus('error', err.message); }
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
  if (el) el.textContent = n + ' chars';
}

function collectAll() {
  document.querySelectorAll('.video-row').forEach(row => {
    const vi = +row.dataset.vi;
    if (isNaN(vi)) return;
    videos[vi].roadmap.segments = [];
    row.querySelectorAll('.seg').forEach(seg => {
      videos[vi].roadmap.segments.push({
        id: Date.now() + Math.random(),
        type: seg.dataset.type,
        title: seg.querySelector('.seg-title').value,
        desc:  seg.querySelector('.seg-desc').value,
        notes: seg.querySelector('.seg-notes').value
      });
    });
  });
}

function buildFilter() {
  const statuses = [...new Set(videos.map(v => v.status || '(none)'))].sort();
  const sel = document.getElementById('statusFilter');
  sel.innerHTML = '<option value="">All (' + videos.length + ')</option>' +
    statuses.map(s => {
      const c = videos.filter(v => (v.status||'(none)') === s).length;
      return '<option value="' + esc(s) + '">' + esc(s) + ' (' + c + ')</option>';
    }).join('');
  document.getElementById('statusCounts').innerHTML = statuses.map(s => {
    const c = videos.filter(v => (v.status||'(none)') === s).length;
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

// ── Render ───────────────────────────────────────────────────
function render() {
  const c = document.getElementById('videos');
  if (!videos.length) {
    c.innerHTML = '<div class="empty"><h2>No videos</h2><p>Make sure some cards have "Beat Sheetin" checked</p></div>';
    return;
  }

  // Preserve which media panels are open
  const openPanels = {};
  document.querySelectorAll('.mp-body.open').forEach(el => {
    openPanels[el.id.replace('mpb-','')] = true;
  });

  c.innerHTML = videos.map((v, vi) =>
    '<div class="video-row" data-vi="' + vi + '" data-status="' + esc(v.status || '(none)') + '">' +
      '<div class="video-row-main">' +
        '<div class="video-info">' +
          '<div class="video-meta"><span class="video-num">#' + (vi+1) + '</span><span class="video-status">' + esc(v.status||'-') + '</span></div>' +
          '<input class="video-title" value="' + esc(v.title) + '" placeholder="Title...">' +
          '<div class="video-info-row">' +
            (v.videoUrl ? '<a class="url-btn" href="' + esc(v.videoUrl) + '" target="_blank" rel="noopener">URL</a>' : '<span class="url-btn" style="opacity:0.4;cursor:default">no url</span>') +
            '<span class="char-count" id="cc-' + vi + '">' + videoCharCount(v) + ' chars</span>' +
          '</div>' +
          '<div class="video-hook">' + esc(v.hook || 'No hook') + '</div>' +
        '</div>' +
        '<div class="segments" data-vi="' + vi + '">' +
          (v.roadmap?.segments || []).map((s, si) => renderSeg(vi, si, s)).join('<span class="arrow">&#8594;</span>') +
          '<div class="add-seg" onclick="addSeg(' + vi + ')">+</div>' +
        '</div>' +
      '</div>' +
      renderMediaPanel(v, vi) +
    '</div>'
  ).join('');

  // Restore open panels
  Object.keys(openPanels).forEach(vi => {
    const body = document.getElementById('mpb-' + vi);
    const arrow = document.getElementById('mpa-' + vi);
    if (body) { body.classList.add('open'); body.style.display = 'flex'; }
    if (arrow) arrow.textContent = '&#9662;';
  });

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

  // seg-desc: always a textarea; rows=3 in normal mode, auto-resize in wrap mode
  const descAttrs = wrapMode
    ? 'oninput="autoResize(this);updateCharCount(' + vi + ')"'
    : 'rows="3" oninput="updateCharCount(' + vi + ')"';

  return '<div class="seg ' + s.type + '" data-type="' + s.type + '" data-vi="' + vi + '" data-si="' + si + '" draggable="true">' +
    '<div class="seg-header">' +
      '<select class="seg-type" onchange="chgType(this)">' +
        TYPES.map(t => '<option value="' + t + '"' + (t === s.type ? ' selected' : '') + '>' + t.replace(/-/g,' ').toUpperCase() + '</option>').join('') +
      '</select>' +
      '<div class="seg-controls">' +
        '<button class="seg-btn" onclick="moveSeg(' + vi + ',' + si + ',-1)" title="Left">&#8592;</button>' +
        '<button class="seg-btn" onclick="moveSeg(' + vi + ',' + si + ',1)"  title="Right">&#8594;</button>' +
        '<button class="seg-btn" onclick="copySeg(' + vi + ',' + si + ')"    title="Copy">&#x2398;</button>' +
        '<button class="seg-btn" onclick="pasteSeg(' + vi + ',' + si + ')"   title="Paste">&#x2397;</button>' +
        '<button class="seg-btn delete" onclick="delSeg(' + vi + ',' + si + ')" title="Delete">&#215;</button>' +
      '</div>' +
      '<button class="seg-btn seg-menu-btn" onclick="toggleMenu(this,event,' + vi + ',' + si + ')" title="Actions">&#8942;</button>' +
    '</div>' +
    titleHtml +
    '<textarea class="seg-desc" placeholder="Description..." ' + descAttrs + '>' + esc(s.desc) + '</textarea>' +
    notesHtml +
  '</div>';
}

// ── Media panel ──────────────────────────────────────────────
function renderMediaPanel(v, vi) {
  const items = v.mediaIndex || [];
  const imgCnt   = items.filter(m => m.kind === 'image').length;
  const audioCnt = items.filter(m => m.kind === 'audio').length;
  const vidCnt   = items.filter(m => m.kind === 'video').length;
  const parts = [];
  if (imgCnt)   parts.push(imgCnt   + ' image' + (imgCnt   > 1 ? 's' : ''));
  if (audioCnt) parts.push(audioCnt + ' audio');
  if (vidCnt)   parts.push(vidCnt   + ' video' + (vidCnt   > 1 ? 's' : ''));
  const countStr = parts.join(' &middot; ') || '';

  const bodyHtml = items.length
    ? items.map(m => renderMediaItem(m, vi)).join('')
    : '<span class="mp-empty">No media yet. Add images, audio, or video below.</span>';

  const pid = esc(v.id);
  return '<div class="media-panel" id="mp-' + vi + '">' +
    '<div class="mp-header" onclick="toggleMediaPanel(' + vi + ')">' +
      '<span class="mp-arrow" id="mpa-' + vi + '">&#9658;</span>' +
      '<span class="mp-label">Media</span>' +
      (countStr ? '<span class="mp-count">' + countStr + '</span>' : '') +
      '<div class="mp-actions" onclick="event.stopPropagation()">' +
        '<button class="btn mp-btn" onclick="openDraw(\'' + pid + '\',' + vi + ')">&#9998; Draw</button>' +
        '<button class="btn mp-btn" onclick="openImageEdit(\'' + pid + '\',' + vi + ')">&#128444; Image</button>' +
        '<button class="btn mp-btn mp-btn-record" id="recbtn-' + vi + '" onclick="startRecord(\'' + pid + '\',' + vi + ')">&#9210; Record</button>' +
        '<button class="btn mp-btn" onclick="uploadFile(\'' + pid + '\',' + vi + ',\'audio\')">&#8593; Audio</button>' +
        '<button class="btn mp-btn" onclick="uploadFile(\'' + pid + '\',' + vi + ',\'video\')">&#127909; Video</button>' +
      '</div>' +
    '</div>' +
    '<div class="mp-body" id="mpb-' + vi + '">' + bodyHtml + '</div>' +
  '</div>';
}

function renderMediaItem(m, vi) {
  const r2  = esc(m.r2_key);
  const bid = esc(m.block_id || 'unknown');
  const del = '<button class="mp-del" title="Delete" data-vi="' + vi + '" data-r2="' + r2 + '" data-bid="' + bid + '" onclick="deleteMedia(this)">&#215;</button>';

  if (m.kind === 'image') {
    return '<div class="mp-item">' +
      '<img class="mp-thumb" src="' + esc(m.public_url) + '" loading="lazy" title="' + esc(m.filename||'') + '">' +
      del + '</div>';
  }
  if (m.kind === 'audio') {
    return '<div class="mp-item mp-item-audio">' +
      '<audio controls src="' + esc(m.public_url) + '" style="height:32px;max-width:220px"></audio>' +
      '<span class="mp-filename">' + esc(m.filename || 'audio') + '</span>' +
      del + '</div>';
  }
  if (m.kind === 'video') {
    return '<div class="mp-item mp-item-video">' +
      '<video controls src="' + esc(m.public_url) + '" style="max-height:130px;max-width:200px" preload="metadata"></video>' +
      (m.description ? '<p class="mp-vid-desc">' + esc(m.description) + '</p>' : '') +
      del + '</div>';
  }
  return '';
}

function toggleMediaPanel(vi) {
  const body  = document.getElementById('mpb-' + vi);
  const arrow = document.getElementById('mpa-' + vi);
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  body.style.display = isOpen ? 'none' : 'flex';
  if (arrow) arrow.innerHTML = isOpen ? '&#9658;' : '&#9662;';
}

function refreshMediaPanelDOM(vi) {
  const old = document.getElementById('mp-' + vi);
  if (!old) return;
  const wasOpen = document.getElementById('mpb-' + vi)?.classList.contains('open');
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMediaPanel(videos[vi], vi);
  old.replaceWith(tmp.firstChild);
  if (wasOpen) {
    const body  = document.getElementById('mpb-' + vi);
    const arrow = document.getElementById('mpa-' + vi);
    if (body)  { body.classList.add('open'); body.style.display = 'flex'; }
    if (arrow) arrow.innerHTML = '&#9662;';
  }
}

// ── Media upload helpers ─────────────────────────────────────
async function getUploadUrl(pageId, filename, kind) {
  const res = await fetch('/api/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notion_id: pageId, filename, kind })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Upload URL request failed'); }
  return res.json();
}
async function doUpload(blob, uploadUrl, contentType) {
  const res = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': contentType || blob.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error('Upload to R2 failed (' + res.status + ')');
}
async function confirmUpload(data) {
  const res = await fetch('/api/confirm-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Confirm upload failed'); }
  return res.json();
}

// Generic file upload (audio or video — images go through the editor)
function uploadFile(pageId, vi, kind) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = kind === 'audio' ? 'audio/*' : 'video/*';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    setStatus('syncing', 'Uploading ' + kind + '...');
    try {
      const { uploadUrl, publicUrl, r2_key } = await getUploadUrl(pageId, file.name, kind);
      await doUpload(file, uploadUrl, file.type);
      let description = '';
      if (kind === 'video') description = window.prompt('Add a description for this video (optional):') || '';
      const { block_id } = await confirmUpload({ notion_id: pageId, r2_key, public_url: publicUrl, kind, filename: file.name, description });
      if (!videos[vi].mediaIndex) videos[vi].mediaIndex = [];
      videos[vi].mediaIndex.push({ r2_key, block_id, kind, filename: file.name, description, public_url: publicUrl });
      refreshMediaPanelDOM(vi);
      // Auto-open the panel to show the new item
      const body = document.getElementById('mpb-' + vi);
      if (body && !body.classList.contains('open')) toggleMediaPanel(vi);
      setStatus('saved', kind.charAt(0).toUpperCase() + kind.slice(1) + ' uploaded!');
      setTimeout(() => setStatus('', 'Ready'), 2000);
    } catch (err) { setStatus('error', err.message); }
  };
  input.click();
}

async function deleteMedia(btn) {
  const vi      = +btn.dataset.vi;
  const r2_key  = btn.dataset.r2;
  const block_id = btn.dataset.bid;
  if (!confirm('Delete this media item?')) return;
  const pageId = videos[vi].id;
  try {
    const res = await fetch('/api/delete-media', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notion_id: pageId, r2_key, block_id })
    });
    if (!res.ok) throw new Error('Delete failed');
    videos[vi].mediaIndex = (videos[vi].mediaIndex || []).filter(m => m.r2_key !== r2_key);
    refreshMediaPanelDOM(vi);
  } catch (err) { setStatus('error', err.message); }
}

// ── Audio recording ──────────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];
let recCtx        = null;  // { pageId, vi }

async function startRecord(pageId, vi) {
  if (mediaRecorder && mediaRecorder.state === 'recording') { stopRecord(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks  = [];
    recCtx       = { pageId, vi };
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      document.getElementById('rec-indicator').classList.remove('show');
      const btn = document.getElementById('recbtn-' + recCtx.vi);
      if (btn) btn.classList.remove('recording');

      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const filename = 'recording-' + Date.now() + '.webm';
      setStatus('syncing', 'Uploading audio...');
      try {
        const { uploadUrl, publicUrl, r2_key } = await getUploadUrl(recCtx.pageId, filename, 'audio');
        await doUpload(blob, uploadUrl, 'audio/webm');
        const { block_id } = await confirmUpload({ notion_id: recCtx.pageId, r2_key, public_url: publicUrl, kind: 'audio', filename });
        if (!videos[recCtx.vi].mediaIndex) videos[recCtx.vi].mediaIndex = [];
        videos[recCtx.vi].mediaIndex.push({ r2_key, block_id, kind: 'audio', filename, description: '', public_url: publicUrl });
        const curVi = recCtx.vi;
        refreshMediaPanelDOM(curVi);
        const body = document.getElementById('mpb-' + curVi);
        if (body && !body.classList.contains('open')) toggleMediaPanel(curVi);
        setStatus('saved', 'Audio saved!');
        setTimeout(() => setStatus('', 'Ready'), 2000);
      } catch (err) { setStatus('error', err.message); }
      mediaRecorder = null; recCtx = null;
    };
    mediaRecorder.start();
    document.getElementById('rec-indicator').classList.add('show');
    const btn = document.getElementById('recbtn-' + vi);
    if (btn) btn.classList.add('recording');
  } catch (err) { alert('Microphone access denied: ' + err.message); }
}
function stopRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}

// ── Image / drawing editor (tui-image-editor) ────────────────
let tuiEditor = null;
let editorCtx = null;  // { pageId, vi }

function openDraw(pageId, vi) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 700;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1200, 700);
  initEditor(canvas.toDataURL(), pageId, vi);
}

function openImageEdit(pageId, vi) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => initEditor(ev.target.result, pageId, vi);
    reader.readAsDataURL(file);
  };
  input.click();
}

function initEditor(imgDataUrl, pageId, vi) {
  editorCtx = { pageId, vi };
  if (tuiEditor) { try { tuiEditor.destroy(); } catch {} tuiEditor = null; }
  document.getElementById('tui-editor-container').innerHTML = '';
  document.getElementById('editor-modal').classList.add('open');

  const w = Math.min(window.innerWidth - 80, 1100);
  const h = Math.min(window.innerHeight - 180, 620);

  if (typeof tui === 'undefined' || !tui.ImageEditor) {
    alert('Image editor is loading — please try again in a moment.');
    document.getElementById('editor-modal').classList.remove('open');
    return;
  }

  tuiEditor = new tui.ImageEditor('#tui-editor-container', {
    includeUI: {
      loadImage: { path: imgDataUrl, name: 'canvas' },
      menu: ['draw', 'shape', 'text', 'crop', 'flip', 'rotate'],
      initMenu: 'draw',
      menuBarPosition: 'left',
    },
    cssMaxWidth:  w,
    cssMaxHeight: h,
    usageStatistics: false
  });
}

async function saveEditor() {
  if (!tuiEditor) return;
  const dataUrl = tuiEditor.toDataURL({ format: 'png' });
  document.getElementById('editor-modal').classList.remove('open');
  const ctx = editorCtx;
  editorCtx = null;

  const blob = await fetch(dataUrl).then(r => r.blob());
  const filename = 'image-' + Date.now() + '.png';
  setStatus('syncing', 'Uploading image...');
  try {
    const { uploadUrl, publicUrl, r2_key } = await getUploadUrl(ctx.pageId, filename, 'image');
    await doUpload(blob, uploadUrl, 'image/png');
    const { block_id } = await confirmUpload({ notion_id: ctx.pageId, r2_key, public_url: publicUrl, kind: 'image', filename });
    if (!videos[ctx.vi].mediaIndex) videos[ctx.vi].mediaIndex = [];
    videos[ctx.vi].mediaIndex.push({ r2_key, block_id, kind: 'image', filename, description: '', public_url: publicUrl });
    refreshMediaPanelDOM(ctx.vi);
    const body = document.getElementById('mpb-' + ctx.vi);
    if (body && !body.classList.contains('open')) toggleMediaPanel(ctx.vi);
    setStatus('saved', 'Image saved!');
    setTimeout(() => setStatus('', 'Ready'), 2000);
  } catch (err) { setStatus('error', err.message); }

  try { tuiEditor.destroy(); } catch {}
  tuiEditor = null;
}

function cancelEditor() {
  document.getElementById('editor-modal').classList.remove('open');
  if (tuiEditor) { try { tuiEditor.destroy(); } catch {} tuiEditor = null; }
  editorCtx = null;
}

// ── Compact overflow menu ────────────────────────────────────
function toggleMenu(btn, e, vi, si) {
  e.stopPropagation();
  const seg = btn.closest('.seg');
  const existing = seg.querySelector('.seg-dropdown');
  closeMenus();
  if (existing) return;
  const m = document.createElement('div');
  m.className = 'seg-dropdown';
  m.innerHTML =
    '<button onclick="moveSeg(' + vi + ',' + si + ',-1);closeMenus()">&#8592; Move Left</button>' +
    '<button onclick="moveSeg(' + vi + ',' + si + ',1);closeMenus()">&#8594; Move Right</button>' +
    '<button onclick="copySeg(' + vi + ',' + si + ');closeMenus()">&#x2398; Copy</button>' +
    '<button onclick="pasteSeg(' + vi + ',' + si + ');closeMenus()">&#x2397; Paste</button>' +
    '<button class="del" onclick="delSeg(' + vi + ',' + si + ')">&#215; Delete</button>';
  seg.appendChild(m);
}
function closeMenus() { document.querySelectorAll('.seg-dropdown').forEach(m => m.remove()); }

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
    selectedVi = null; selectedSi = null;
  }
});

// ── Card mutations ───────────────────────────────────────────
function chgType(sel) {
  const seg = sel.closest('.seg');
  TYPES.forEach(t => seg.classList.remove(t));
  seg.classList.add(sel.value);
  seg.dataset.type = sel.value;
  collectAll(); saveHistory();
}
function addSeg(vi) {
  collectAll();
  videos[vi].roadmap.segments.push({ id: Date.now(), type: 'body', title: '', desc: '', notes: '' });
  saveHistory(); render();
}
function delSeg(vi, si) {
  collectAll();
  videos[vi].roadmap.segments.splice(si, 1);
  saveHistory(); render();
}
function moveSeg(vi, si, dir) {
  collectAll();
  const segs = videos[vi].roadmap.segments;
  const np = si + dir;
  if (np < 0 || np >= segs.length) return;
  const [s] = segs.splice(si, 1);
  segs.splice(np, 0, s);
  saveHistory(); render();
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
  saveHistory(); render(); showToast('Pasted!');
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1500);
}

// ── Drag & Drop ──────────────────────────────────────────────
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
      const prev = segs[index].previousSibling;
      const before = (prev && prev.classList && prev.classList.contains('arrow')) ? prev : segs[index];
      container.insertBefore(ind, before);
    }
  }
  function clearDropIndicators() { document.querySelectorAll('.drop-indicator').forEach(el => el.remove()); }

  document.querySelectorAll('.seg').forEach(seg => {
    seg.ondragstart = e => {
      dragData = { vi: +seg.dataset.vi, si: +seg.dataset.si };
      seg.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    };
    seg.ondragend = () => { seg.classList.remove('dragging'); clearDropIndicators(); dragData = null; };
  });
  document.querySelectorAll('.segments').forEach(container => {
    container.ondragover = e => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      showDropIndicator(container, calcDropIndex(container, e.clientX));
    };
    container.ondragleave = e => { if (!container.contains(e.relatedTarget)) clearDropIndicators(); };
    container.ondrop = e => {
      e.preventDefault();
      if (!dragData) return;
      const toVi = +container.dataset.vi;
      const toSi = calcDropIndex(container, e.clientX);
      clearDropIndicators(); collectAll();
      const [moved] = videos[dragData.vi].roadmap.segments.splice(dragData.si, 1);
      videos[toVi].roadmap.segments.splice(toSi, 0, moved);
      saveHistory(); render();
    };
  });
}

// ── Wrap mode ────────────────────────────────────────────────
function toggleWrap() {
  wrapMode = !wrapMode;
  document.getElementById('wrapBtn').classList.toggle('btn-active', wrapMode);
  collectAll();
  render();
  if (wrapMode) setupWrapResize();
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
function setupWrapResize() {
  document.querySelectorAll('.seg-ta, .seg-desc').forEach(el => {
    autoResize(el);
    if (!el._arBound) {
      el._arBound = true;
      el.addEventListener('input', () => autoResize(el));
    }
  });
}

// ── Print helpers ────────────────────────────────────────────
window.addEventListener('beforeprint', () => {
  collectAll();

  // Add QR codes from data model (not DOM)
  videos.forEach((v, vi) => {
    const row = document.querySelector('.video-row[data-vi="' + vi + '"]');
    if (!row || row.classList.contains('hidden')) return;
    const infoPanel = row.querySelector('.video-info');

    if (v.videoUrl && infoPanel && typeof qrcode !== 'undefined') {
      try {
        const qr = qrcode(0, 'M');
        qr.addData(v.videoUrl);
        qr.make();
        const div = document.createElement('div');
        div.className = 'print-qr';
        div.innerHTML = qr.createSvgTag({ scalable: true, width: '64px', height: '64px' });
        infoPanel.appendChild(div);
      } catch {}
    }

    // Create .pf divs from data model to avoid stale input values
    const segs = v.roadmap?.segments || [];
    row.querySelectorAll('.seg').forEach((segEl, si) => {
      const s = segs[si];
      if (!s) return;
      const mk = (cls, val) => {
        const d = document.createElement('div');
        d.className = 'pf ' + cls;
        d.textContent = val || '';
        segEl.appendChild(d);
      };
      mk('pf-type',  s.type.replace(/-/g,' ').toUpperCase());
      mk('pf-title', s.title || '');
      if (s.desc)  mk('pf-desc',  s.desc);
      if (s.notes) mk('pf-notes', s.notes);
    });
  });
});
window.addEventListener('afterprint', () => {
  document.querySelectorAll('.pf, .print-qr').forEach(el => el.remove());
});

function esc(s) {
  return s ? String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
}

initScale();
pullFromNotion();
</script>

<!-- Load tui-image-editor after page is interactive -->
<script src="https://cdn.jsdelivr.net/npm/tui-image-editor@3.15.4/dist/tui-image-editor.min.js" defer></script>
</body>
</html>`;
}
