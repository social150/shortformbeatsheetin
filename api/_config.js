// Shared constants and helpers for all api functions
const FIELD_TITLE       = 'Idea';
const FIELD_HOOK        = 'Hook';
const FIELD_BEATSHEET   = 'Beat Sheet';
const FIELD_MEDIA_INDEX = 'Media Index';
const FIELD_BEAT_SHEETIN = 'Beat Sheetin';
const FIELD_STATUS      = 'Status';

// Join array of Notion rich_text objects into a single string
function fromRichText(arr) {
  return (arr || []).map(r => r.plain_text || '').join('');
}

// Split a string into an array of Notion rich_text objects (2000 chars each)
function toRichText(str) {
  const chunks = [];
  for (let i = 0; i < str.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: str.slice(i, i + 2000) } });
  }
  if (!chunks.length) chunks.push({ type: 'text', text: { content: '' } });
  return chunks;
}

module.exports = { FIELD_TITLE, FIELD_HOOK, FIELD_BEATSHEET, FIELD_MEDIA_INDEX, FIELD_BEAT_SHEETIN, FIELD_STATUS, fromRichText, toRichText };
