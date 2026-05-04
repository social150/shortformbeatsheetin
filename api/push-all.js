// api/push-all.js — Vercel serverless function
const { Client } = require('@notionhq/client');
const { FIELD_BEATSHEET, FIELD_HOOK, toRichText } = require('./_config');

const CONCURRENCY = 3;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  try {
    const notion = new Client({ auth: process.env.NOTION_TOKEN });
    const videos = req.body;

    for (let i = 0; i < videos.length; i += CONCURRENCY) {
      const batch = videos.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(video =>
        notion.pages.update({
          page_id: video.id,
          properties: {
            [FIELD_BEATSHEET]: {
              // Split JSON across up to 100 x 2000-char elements (~200K chars total)
              rich_text: toRichText(JSON.stringify(video.roadmap))
            },
            [FIELD_HOOK]: {
              rich_text: toRichText(video.hook || '')
            }
          }
        })
      ));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
