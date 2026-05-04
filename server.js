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
    if (!roadmap || !Array.isArray(roadmap.segments) || !roadmap.segments.length) {
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
  return require('fs').readFileSync(__dirname + '/public/index.html', 'utf8');
}
