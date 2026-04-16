// api/push-all.js — Vercel serverless function
// Pushes all videos to Notion in parallel batches of 3
const { Client } = require('@notionhq/client');

const FIELD_BEATSHEET = 'Beat Sheet';
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
              rich_text: [{ text: { content: JSON.stringify(video.roadmap) } }]
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
