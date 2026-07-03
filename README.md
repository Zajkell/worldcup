# World Cup 2026 — Pula zakładów

A single-page web app for running a friendly World Cup 2026 betting pool among a fixed group of players.

## Features

- Login per player (name + password, first login sets the password)
- Bet on match scores, locked 15 minutes before kickoff
- Live leaderboard, points chart, and "form" ranking (last 5 matches)
- FUT-style player cards generated from betting stats
- Special bets: top scorer and tournament winner (+5 pts each)
- Live activity feed and optional push notifications before kickoff

## Tech stack

- Plain HTML/CSS/JavaScript — no build step, no framework
- [Supabase](https://supabase.com/) for data storage (`pool_data` table) via the JS client loaded from CDN

## Running locally

This is a static single file, so any static file server works, e.g.:

```bash
npx serve .
```

Then open the served URL in your browser. The app connects to a Supabase project configured via `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `index.html`.
