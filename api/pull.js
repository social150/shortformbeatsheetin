// api/pull.js — Vercel serverless function
const { Client } = require('@notionhq/client');

const FIELD_TITLE = 'Idea';
const FIELD_HOOK = 'Hook';
const FIELD_BEATSHEET = 'Beat Sheet';
const FIELD_BEAT_SHEETIN = 'Beat Sheetin';
const FIELD_STATUS = 'Status';

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
      return { id: page.id, url: page.url, title, hook, status, roadmap };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(videos));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
