# Financial Model App

Static web app — no backend, no build step needed.

## Run locally

```bash
# Option 1: Python
python3 -m http.server 8080
# Open http://localhost:8080

# Option 2: Node
npx serve .
# Open http://localhost:3000

# Option 3: VS Code
# Install "Live Server" extension, right-click index.html → Open with Live Server
```

## Deploy to Vercel

### Option A — Vercel CLI (fastest)
```bash
npm i -g vercel
cd financial-model
vercel
# Follow prompts → deployed in ~30 seconds
```

### Option B — Vercel Dashboard (drag & drop)
1. Go to https://vercel.com/new
2. Click "Deploy from file upload" or drag the project folder
3. No configuration needed — Vercel detects static HTML automatically

### Option C — GitHub
1. Push this folder to a GitHub repo
2. Go to https://vercel.com/new → Import Git Repository
3. Select your repo → Deploy (no build settings needed)

## File structure
```
financial-model/
├── index.html      # Main app shell + modals
├── style.css       # All styles
├── script.js       # All logic (compute, render, UI)
├── vercel.json     # Vercel static deployment config
└── README.md       # This file
```

## Notes
- All data saved to browser localStorage (per device)
- No server, no database, no API keys needed
- Works fully offline after first load
