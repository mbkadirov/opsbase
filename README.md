# OpsBase — Setup Guide

## Step 1: Run the database schema

1. Go to your Supabase dashboard → **SQL Editor**
2. Open `schema.sql` from this folder
3. Paste the entire contents and click **Run**

This creates your `stores` and `issues` tables and seeds all 74 locations.

---

## Step 2: Deploy to Vercel

### Option A — GitHub (recommended)
1. Create a free account at **github.com**
2. Create a new repository called `opsbase`
3. Upload all files from this folder
4. Go to **vercel.com** → sign up with GitHub
5. Click **Add New Project** → import your `opsbase` repo
6. Click **Deploy** — done in 60 seconds

### Option B — Vercel CLI
```bash
npm i -g vercel
cd /path/to/opsbase
vercel
```

---

## Step 3: Install as mobile app (PWA)

### iPhone
1. Open your Vercel URL in Safari
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Tap **Add**

### Android
1. Open your Vercel URL in Chrome
2. Tap the **⋮** menu
3. Tap **Add to Home screen**

---

## File structure

```
opsbase/
├── index.html          Main app
├── manifest.json       PWA config
├── sw.js               Service worker (offline support)
├── vercel.json         Vercel routing config
├── schema.sql          Run this in Supabase first
├── css/
│   └── app.css         All styles
└── js/
    ├── supabase.js     Database client
    └── app.js          App logic
```

---

## Supabase credentials (already in js/supabase.js)
- URL: https://njakbmroejvnasvjzefl.supabase.co
- Key: stored in js/supabase.js

---

## Next steps (when ready)
- Add login/auth so supervisors have limited access
- Add photo attachments to issues
- Add export to PDF or email reports
- Add push notifications for open issues
