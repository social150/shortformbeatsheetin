// api/delete-media.js — Delete a media item from R2 + Notion block + Media Index
const { Client } = require('@notionhq/client');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { FIELD_MEDIA_INDEX, fromRichText, toRichText } = require('./_config');

module.exports = async (req, res) => {
  if (req.method !== 'DELETE') { res.writeHead(405); return res.end(); }

  const { notion_id, r2_key, block_id } = req.body || {};
  if (!notion_id || !r2_key) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing notion_id or r2_key' }));
  }

  try {
    const notion = new Client({ auth: process.env.NOTION_TOKEN });

    // 1. Delete from R2 (if configured)
    if (process.env.CLOUDFLARE_R2_ACCOUNT_ID) {
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
        },
      });
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.CLOUDFLARE_R2_BUCKET, Key: r2_key }));
      } catch {}
    }

    // 2. Delete the Notion block (best-effort)
    if (block_id && block_id !== 'unknown') {
      try { await notion.blocks.delete({ block_id }); } catch {}
    }

    // 3. Remove entry from Media Index property
    const page = await notion.pages.retrieve({ page_id: notion_id });
    const existing = fromRichText(page.properties[FIELD_MEDIA_INDEX]?.rich_text);
    let mediaIndex = [];
    try { mediaIndex = existing ? JSON.parse(existing) : []; } catch { mediaIndex = []; }
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
};
