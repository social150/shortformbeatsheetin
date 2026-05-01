// api/confirm-upload.js — After browser uploads to R2, write the block to Notion + update Media Index
const { Client } = require('@notionhq/client');
const { FIELD_MEDIA_INDEX, fromRichText, toRichText } = require('./_config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  const { notion_id, r2_key, public_url, kind, filename, description } = req.body || {};
  if (!notion_id || !r2_key || !public_url || !kind) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required fields' }));
  }

  try {
    const notion = new Client({ auth: process.env.NOTION_TOKEN });

    // 1. Append a native block to the Notion page body
    const blockType = kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'image';
    let blockResponse;
    try {
      blockResponse = await notion.blocks.children.append({
        block_id: notion_id,
        children: [{
          type: blockType,
          [blockType]: { type: 'external', external: { url: public_url } }
        }]
      });
    } catch {
      // Page body blocks are optional — continue even if this fails
      blockResponse = { results: [{ id: 'unknown' }] };
    }
    const block_id = blockResponse.results?.[0]?.id || 'unknown';

    // 2. Update the Media Index property
    const page = await notion.pages.retrieve({ page_id: notion_id });
    const existing = fromRichText(page.properties[FIELD_MEDIA_INDEX]?.rich_text);
    let mediaIndex = [];
    try { mediaIndex = existing ? JSON.parse(existing) : []; } catch { mediaIndex = []; }
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
};
