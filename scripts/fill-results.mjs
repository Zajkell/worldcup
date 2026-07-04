// Cloud result filler for the World Cup 2026 betting pool.
//
// Runs on GitHub Actions (cron) — no personal computer required. Self-contained:
// reads FIXTURES + Supabase credentials from the repo's index.html, pulls match
// data from ESPN's free key-less JSON API, and writes REGULATION-TIME (90 min)
// scores into Supabase. Never overwrites an existing result; never guesses an
// unfinished match. Idempotent, so it's safe to run alongside the local task.
//
// Regulation-only rule: for knockout games that went to extra time / penalties
// we do NOT use the headline score (it includes ET). We recompute from the
// scoring plays, counting only goals in the regulation periods (excludes ET +
// shootout). Verified: Argentina-Cape Verde headline 3:2 AET -> recorded 1:1.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML_PATH = fileURLToPath(new URL("../index.html", import.meta.url));
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";

const html = readFileSync(HTML_PATH, "utf8");
const SB_URL = html.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)[1];
const SB_KEY = html.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)[1];
const SBH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const block = html.match(/const FIXTURES\s*=\s*(\[[\s\S]*?\]);/)[1];
const jsonish = block
  .replace(/\/\/[^\n]*/g, "")
  .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
  .replace(/,\s*]/g, "]");
const fixtures = JSON.parse(jsonish);

// current data blob
const g = await fetch(`${SB_URL}/rest/v1/pool_data?id=eq.1&select=data`, { headers: SBH });
if (!g.ok) throw new Error("Supabase GET " + g.status);
const rows = await g.json();
const data = rows[0]?.data || {};
data.results = data.results || {};

const now = Date.now();
const missing = fixtures.filter(m => !data.results[m.id] && new Date(m.kickoff).getTime() <= now);
if (missing.length === 0) { console.log("BRAK: wszystkie rozegrane mecze maja wynik."); process.exit(0); }

// team-name matching across sources
const ALIAS_GROUPS = [
  ["usa", "unitedstates", "unitedstatesofamerica"],
  ["southkorea", "korearepublic", "korea"],
  ["northkorea", "koreadpr"],
  ["iran", "irian", "islamicrepublicofiran"],
  ["ivorycoast", "cotedivoire"],
  ["czechia", "czechrepublic"],
  ["capeverde", "caboverde"],
  ["bosnia", "bosniaandherzegovina", "bosniaherzegovina"],
  ["china", "chinapr"],
  ["curacao", "curaao"],
  ["turkey", "turkiye", "trkiye"],
  ["drcongo", "democraticrepublicofthecongo", "congodr"],
  ["congo", "republicofthecongo"],
];
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const canon = name => { const n = norm(name); for (const grp of ALIAS_GROUPS) if (grp.includes(n)) return grp[0]; return n; };
const sameTeam = (a, b) => canon(a) === canon(b);

const dateCache = new Map();
async function eventsOnDate(yyyymmdd) {
  if (dateCache.has(yyyymmdd)) return dateCache.get(yyyymmdd);
  const r = await fetch(`${ESPN}/scoreboard?dates=${yyyymmdd}`);
  if (!r.ok) throw new Error("ESPN scoreboard " + r.status);
  const list = (await r.json()).events || [];
  dateCache.set(yyyymmdd, list);
  return list;
}
async function regulationScore(eventId) {
  const j = await (await fetch(`${ESPN}/summary?event=${eventId}`)).json();
  const comp = j.header.competitions[0];
  const home = comp.competitors.find(c => c.homeAway === "home");
  const away = comp.competitors.find(c => c.homeAway === "away");
  const regPeriods = j.format?.regulation?.periods ?? 2;
  let h = 0, a = 0;
  for (const p of j.keyEvents || []) {
    if (!p.scoringPlay || p.shootout) continue;
    if ((p.period?.number ?? 99) > regPeriods) continue;
    if (!p.team) continue;
    if (String(p.team.id) === String(home.team.id)) h++;
    else if (String(p.team.id) === String(away.team.id)) a++;
  }
  return { homeName: home.team.displayName, awayName: away.team.displayName, home: h, away: a };
}

const applied = [];
const pending = [];
let log = data.activityLog || [];

for (const m of missing) {
  const yyyymmdd = new Date(m.kickoff).toISOString().slice(0, 10).replace(/-/g, "");
  let events;
  try { events = await eventsOnDate(yyyymmdd); }
  catch (e) { pending.push(`${m.id} (${e.message})`); continue; }

  const ev = events.find(e => {
    const cs = e.competitions[0].competitors;
    const H = cs.find(c => c.homeAway === "home")?.team?.displayName;
    const A = cs.find(c => c.homeAway === "away")?.team?.displayName;
    return H && A && ((sameTeam(H, m.home) && sameTeam(A, m.away)) || (sameTeam(H, m.away) && sameTeam(A, m.home)));
  });
  if (!ev) { pending.push(`${m.id} ${m.home}-${m.away} (brak w ESPN)`); continue; }

  const comp = ev.competitions[0];
  const st = comp.status.type;
  if (!st.completed) { pending.push(`${m.id} ${m.home}-${m.away} (${st.name})`); continue; }

  const wentBeyond90 = /AET|PEN|_ET|EXTRA/i.test(st.name) || comp.competitors.some(c => c.shootoutScore != null);
  const espnHome = comp.competitors.find(c => c.homeAway === "home");
  const espnAway = comp.competitors.find(c => c.homeAway === "away");

  let regHomeName, rh, ra;
  try {
    if (wentBeyond90) { const r = await regulationScore(ev.id); regHomeName = r.homeName; rh = r.home; ra = r.away; }
    else { regHomeName = espnHome.team.displayName; rh = Number(espnHome.score); ra = Number(espnAway.score); }
  } catch (e) { pending.push(`${m.id} (summary ${e.message})`); continue; }

  if (!Number.isFinite(rh) || !Number.isFinite(ra)) { pending.push(`${m.id} (nieczytelny)`); continue; }

  const espnHomeIsOurHome = sameTeam(regHomeName, m.home);
  const home = espnHomeIsOurHome ? rh : ra;
  const away = espnHomeIsOurHome ? ra : rh;
  data.results[m.id] = { home, away };
  const label = `${m.home} - ${m.away}`;
  log = [{ message: `Admin wpisał wynik: ${label} ${home}:${away}`, timestamp: new Date().toISOString() }, ...log];
  applied.push(`${m.id} ${label} ${home}:${away}${wentBeyond90 ? " (90 min)" : ""}`);
}

if (applied.length === 0) {
  console.log("Nic nowego. Oczekuja:\n  " + (pending.join("\n  ") || "-"));
  process.exit(0);
}

data.activityLog = log.slice(0, 100);
const p = await fetch(`${SB_URL}/rest/v1/pool_data?id=eq.1`, {
  method: "PATCH",
  headers: { ...SBH, "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({ data }),
});
if (!p.ok) throw new Error("Supabase PATCH " + p.status + " " + (await p.text()));
console.log("ZAPISANO " + applied.length + ":\n  " + applied.join("\n  "));
if (pending.length) console.log("Oczekuja:\n  " + pending.join("\n  "));
