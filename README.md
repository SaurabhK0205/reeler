# Instagram Saved Reels Tracker & Discovery Dashboard

A fast, intelligent, and lightweight Saved Reels tracker that works alongside Instagram's existing experience. It allows you to search, filter by creator, filter by save date, manage watch status (Unwatched, Watch Later, Watched), and rediscover buried content without manually categorizing Reels into Collections.

---

## 🌟 Key Features

- **Date-Based Filtering:** Filter by Today, Yesterday, Last 7 Days, Last 30 Days, Last 3 Months, Last 6 Months, or This Year.
- **Creator-Based Filtering:** Quick-filter pills and directory showing all creators with count of saved Reels.
- **Instant Search:** Full-text keyword search across captions, creator usernames, and display names.
- **Watch State Management:** Toggle Reels between **Unwatched**, **Watch Later (⏰)**, and **Watched (✅)**.
- **Native Preservation:** Direct links to open the original Reel on Instagram, preserving attribution and video playback.
- **Dual Database Support:**
  - **Supabase (PostgreSQL):** High-speed cloud persistence with GIN full-text search indexes (`to_tsvector`).
  - **In-Memory Demo Fallback:** Zero-setup offline store for instant local testing.

---

## 🚀 Quick Start (Running in 1 Minute)

### 1. Install Dependencies
```bash
cd /Users/thismac/projects/instagram-saved-reels
npm install
```

### 2. (Optional) Seed Demo Data
To test the dashboard immediately with realistic sample Reels:
```bash
npm run seed
```

### 3. Start the Web Dashboard
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser!

---

## 🗄️ Supabase Database Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Go to the **SQL Editor** tab in your Supabase dashboard.
3. Paste and run the contents of [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql).
4. Go to **Project Settings** ➔ **API** and copy:
   - **Project URL**
   - **service_role key** (or anon key)
5. Create your `.env` file:
   ```bash
   cp .env.example .env
   ```
6. Add your keys:
   ```env
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
   ```

---

## 📸 Connecting Your Instagram Account (Syncing Real Saved Reels)

Because Instagram does not expose a public API for personal bookmarks, we use an authenticated session from your desktop browser:

1. Open your browser on this Mac and log in to [instagram.com](https://www.instagram.com).
2. Open Developer Tools (`Cmd + Option + I` or `F12`) ➔ **Application** (or **Storage**) ➔ **Cookies** ➔ `https://www.instagram.com`.
3. Copy these 3 values into your `.env`:
   - `sessionid` ➔ `INSTAGRAM_SESSION_ID`
   - `ds_user_id` ➔ `INSTAGRAM_USER_ID`
   - `csrftoken` ➔ `INSTAGRAM_CSRF_TOKEN`

### Syncing
You can trigger synchronization either:
- By clicking the **"🔄 Sync Saved Reels"** button in the top right of the web dashboard.
- Or running from your terminal:
  ```bash
  npm run sync
  ```

---

## 📐 The Historical Save Date Philosophy

Instagram's internal saved feed returns items in exact reverse chronological order (newest saved first), but does **not** expose an explicit historical `saved_at` timestamp in the JSON payload (only `taken_at`, which is when the creator published the Reel).

To maintain engineering integrity without fabricating timestamps:
1. Every Reel is assigned an exact **`save_order_rank`** (#1 = most recently saved).
2. For past saved Reels, `saved_at` remains `NULL` while `first_detected_at` marks the initial sync date.
3. For newly saved Reels after setup, exact timestamps are captured upon detection.
