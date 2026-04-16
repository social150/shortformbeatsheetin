// sync.js — Simple Notion ↔ Roadmap sync
// Only pulls cards with "Beat Sheetin" checked
// Writes roadmap to "Beat Sheet" field

const { Client } = require('@notionhq/client');
const fs = require('fs');

// ============================================
// CONFIG — Set these or use environment variables
// ============================================
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Your field names (adjust if different)
const FIELD_TITLE = 'Idea';
const FIELD_HOOK = 'Hook';
const FIELD_BEATSHEET = 'Beat Sheet';      // Text field for roadmap JSON
const FIELD_BEAT_SHEETIN = 'Beat Sheetin'; // Checkbox filter
const FIELD_STATUS = 'Status';

const notion = new Client({ auth: NOTION_TOKEN });

// ============================================
// PULL: Notion → videos.json
// ============================================
async function pull() {
  console.log('📥 Pulling from Notion (Beat Sheetin = ✓)...');
  
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: FIELD_BEAT_SHEETIN,
      checkbox: { equals: true }
    },
    page_size: 100
  });

  const videos = response.results.map(page => {
    const p = page.properties;
    
    const title = p[FIELD_TITLE]?.title?.[0]?.plain_text || '';
    const hook = p[FIELD_HOOK]?.rich_text?.[0]?.plain_text || '';
    const status = p[FIELD_STATUS]?.status?.name || p[FIELD_STATUS]?.select?.name || '';
    const storyboardRaw = p[FIELD_BEATSHEET]?.rich_text?.[0]?.plain_text || '';
    
    // Try to parse existing storyboard, or create default
    let roadmap;
    try {
      roadmap = storyboardRaw ? JSON.parse(storyboardRaw) : null;
    } catch { roadmap = null; }

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

    return {
      id: page.id,
      url: page.url,
      title,
      hook,
      status,
      roadmap
    };
  });

  fs.writeFileSync('videos.json', JSON.stringify(videos, null, 2));
  console.log(`✅ Pulled ${videos.length} videos → videos.json`);
}

// ============================================
// PUSH: videos.json → Notion (Beat Sheet only)
// ============================================
async function push() {
  console.log('📤 Pushing to Notion...');
  
  const videos = JSON.parse(fs.readFileSync('videos.json', 'utf8'));
  
  for (const video of videos) {
    if (!video.id) continue;
    
    await notion.pages.update({
      page_id: video.id,
      properties: {
        [FIELD_BEATSHEET]: {
          rich_text: [{ text: { content: JSON.stringify(video.roadmap) } }]
        }
      }
    });
    console.log(`  ✓ ${video.title}`);
  }
  
  console.log('✅ Done');
}

// CLI
const cmd = process.argv[2];
if (cmd === 'pull') pull();
else if (cmd === 'push') push();
else console.log('Usage: node sync.js pull|push');
