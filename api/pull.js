// api/pull.js — Vercel serverless function
const { Client } = require('@notionhq/client');
const { FIELD_TITLE, FIELD_HOOK, FIELD_BEATSHEET, FIELD_MEDIA_INDEX, FIELD_BEAT_SHEETIN, FIELD_STATUS, fromRichText } = require('./_config');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  try {
    const notion = new Client({ auth: process.env.NOTION_TOKEN });
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: { property: FIELD_BEAT_SHEETIN, checkbox: { equals: true } },
      page_size: 100
    });

    const videos = response.results.map(page => {
      const p = page.properties;
      const title  = p[FIELD_TITLE]?.title?.[0]?.plain_text || '';
      const hook   = p[FIELD_HOOK]?.rich_text?.[0]?.plain_text || '';
      const status = p[FIELD_STATUS]?.status?.name || p[FIELD_STATUS]?.select?.name || '';

      // Chunked beat sheet — join all elements before parsing
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

      // Media index (chunked same way)
      const rawMedia = fromRichText(p[FIELD_MEDIA_INDEX]?.rich_text);
      let mediaIndex = [];
      try { mediaIndex = rawMedia ? JSON.parse(rawMedia) : []; } catch { mediaIndex = []; }

      const videoUrl = p['URL']?.url || '';
      return { id: page.id, url: page.url, videoUrl, title, hook, status, roadmap, mediaIndex };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(videos));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
