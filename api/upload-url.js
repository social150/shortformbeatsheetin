// api/upload-url.js — Returns a presigned PUT URL so the browser uploads directly to R2
// R2 bucket CORS must allow PUT from your domains. In Cloudflare R2 dashboard > Bucket > Settings > CORS:
// [{"AllowedOrigins":["*"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const MIME = { image: 'image/png', audio: 'audio/webm', video: 'video/mp4' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  if (!process.env.CLOUDFLARE_R2_ACCOUNT_ID) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'R2 not configured. Add CLOUDFLARE_R2_* env vars.' }));
  }

  const { notion_id, filename, kind } = req.body || {};
  if (!notion_id || !filename || !kind) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing notion_id, filename, or kind' }));
  }

  try {
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
    });

    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'bin';
    const uid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const r2_key = `${notion_id}/${uid}.${ext}`;
    const contentType = MIME[kind] || 'application/octet-stream';

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: process.env.CLOUDFLARE_R2_BUCKET, Key: r2_key, ContentType: contentType }),
      { expiresIn: 3600 }
    );

    const publicUrl = `${process.env.CLOUDFLARE_R2_PUBLIC_URL}/${r2_key}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ uploadUrl, publicUrl, r2_key }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
