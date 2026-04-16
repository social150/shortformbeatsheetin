# Beat Sheet Sync

Pull videos from Notion → Edit in HTML → Push back to Notion

## Setup

1. **Create Notion integration**
   - Go to https://notion.so/my-integrations
   - Create integration, copy the token
   - In your database, click ••• → Add connections → Select your integration

2. **Get your database ID**
   - Open your database in Notion
   - Copy the ID from the URL (the long string before `?v=`)

3. **Install**
   ```bash
   npm install
   ```

4. **Configure** (edit sync.js lines 8-9)
   ```javascript
   const NOTION_TOKEN = 'your-token';
   const DATABASE_ID = 'your-database-id';
   ```
   
   Or use environment variables:
   ```bash
   export NOTION_TOKEN="your-token"
   export NOTION_DATABASE_ID="your-database-id"
   ```

5. **Add Storyboard field** to your Notion database
   - Create a new Text property called `Storyboard`

## Usage

```bash
# Pull videos from Notion
npm run pull
# or: node sync.js pull

# Edit in browser
open roadmap.html
# Load videos.json, edit segments, save videos.json

# Push back to Notion
npm run push
# or: node sync.js push
```

## How it works

- **Pull**: Reads your Notion database, creates `videos.json`
- **Edit**: Open `roadmap.html`, load the JSON, edit your beat sheets
- **Push**: Saves each video's roadmap to the `Storyboard` field in Notion

The Storyboard field stores JSON like:
```json
{
  "segments": [
    {"id": 1, "type": "hook", "title": "...", "desc": "...", "notes": ""},
    {"id": 2, "type": "open-loop", "title": "...", "desc": "...", "notes": "→ Closes at #5"}
  ]
}
```
