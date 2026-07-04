// Auto-add knockout pairings to the World Cup 2026 betting pool.
//
// As teams advance, ESPN schedules the next-round matches and fills each slot
// with the REAL team once that match finishes (winner incl. extra time /
// penalties). This mirrors ESPN's upcoming knockout fixtures into the FIXTURES
// array in index.html — but ONLY once BOTH teams of a match are known (no
// "Round of 16 X Winner" placeholders). Team spelling is taken from the teams
// already in FIXTURES so it stays consistent with the app.
//
// Idempotent: never re-adds a pairing that already exists. Writes index.html
// only when there is something new. Run on GitHub Actions (commits + pushes).
//
//   node scripts/fill-fixtures.mjs           # apply (write index.html if changed)
//   node scripts/fill-fixtures.mjs --dry     # show what it would add, write nothing
//   node scripts/fill-fixtures.mjs --selftest# prove insertion with a fake pairing

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML_PATH = fileURLToPath(new URL("../index.html", import.meta.url));
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const DRY = process.argv.includes("--dry");
const SELFTEST = process.argv.includes("--selftest");

// ESPN round slug -> the group label used by the app. Only these are added.
const ROUND_LABEL = {
  "round-of-32": "1/16",
  "round-of-16": "1/8",
  "quarterfinals": "1/4",
  "semifinals": "1/2",
  "third-place": "o 3. miejsce",
  "final": "Finał",
};

const html = readFileSync(HTML_PATH, "utf8");
const EOL = html.includes("\r\n") ? "\r\n" : "\n";   // preserve the file's line endings

// --- parse existing FIXTURES ----------------------------------------------
const mBlock = html.match(/(const FIXTURES\s*=\s*\[)([\s\S]*?)(\n\];)/);
if (!mBlock) throw new Error("Nie znaleziono tablicy FIXTURES w index.html");
const body = mBlock[2];

const jsonish = body.replace(/\/\/[^\n]*/g, "").replace(/([{,]\s*)(\w+):/g, '$1"$2":').replace(/,\s*$/, "");
const existing = JSON.parse("[" + jsonish + "]");

const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const ALIAS_GROUPS = [
  ["usa", "unitedstates", "unitedstatesofamerica"],
  ["southkorea", "korearepublic", "korea"],
  ["iran", "islamicrepublicofiran"],
  ["ivorycoast", "cotedivoire"],
  ["czechia", "czechrepublic"],
  ["capeverde", "caboverde"],
  ["bosnia", "bosniaandherzegovina", "bosniaherzegovina"],
  ["turkey", "turkiye", "trkiye"],
  ["drcongo", "democraticrepublicofthecongo", "congodr"],
  ["curacao", "curaao"],
];
const canon = name => { const n = norm(name); for (const g of ALIAS_GROUPS) if (g.includes(n)) return g[0]; return n; };

// dictionary canon -> the app's preferred spelling (from existing fixtures)
const spelling = {};
for (const f of existing) { spelling[canon(f.home)] = f.home; spelling[canon(f.away)] = f.away; }
const appName = espn => spelling[canon(espn)] || espn;

// set of pairings already present, keyed by "label|teamA~teamB" (unordered)
const pairKey = (label, a, b) => `${label}|${[canon(a), canon(b)].sort().join("~")}`;
const haveKey = new Set(existing.map(f => pairKey(f.group, f.home, f.away)));

let maxNum = existing.reduce((mx, f) => Math.max(mx, parseInt(f.id.slice(1), 10) || 0), 0);

// --- collect resolved knockout pairings from ESPN --------------------------
const isPlaceholder = name =>
  /winner|loser|runner|tbd|to be determined|round of|group\s|quarterfinal|semifinal|1st|2nd|3rd|place/i.test(name);

function isoSeconds(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z"); }

async function collectFromEspn() {
  const out = [];
  const seen = new Set();
  const start = new Date("2026-07-05T00:00:00Z");
  const end = new Date("2026-07-20T00:00:00Z");
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
    let events;
    try { events = (await (await fetch(`${ESPN}/scoreboard?dates=${d}`)).json()).events || []; }
    catch { continue; }
    for (const e of events) {
      const label = ROUND_LABEL[e.season?.slug];
      if (!label) continue;                       // group stage / unknown round
      if (seen.has(e.id)) continue; seen.add(e.id);
      const cs = e.competitions[0].competitors;
      const H = cs.find(c => c.homeAway === "home")?.team?.displayName;
      const A = cs.find(c => c.homeAway === "away")?.team?.displayName;
      if (!H || !A || isPlaceholder(H) || isPlaceholder(A)) continue; // slot not resolved yet
      out.push({ label, home: H, away: A, kickoff: isoSeconds(e.date) });
    }
  }
  return out;
}

// --- build new fixture lines + insert into html ----------------------------
function buildAdditions(resolved, htmlText) {
  const additions = [];
  for (const r of resolved.sort((a, b) => a.kickoff.localeCompare(b.kickoff))) {
    const key = pairKey(r.label, r.home, r.away);
    if (haveKey.has(key)) continue;
    haveKey.add(key);
    const home = appName(r.home), away = appName(r.away);
    additions.push({ id: `m${++maxNum}`, group: r.label, home, away, kickoff: r.kickoff });
  }
  if (additions.length === 0) return { additions, newHtml: htmlText };

  const line = f => `  {id:"${f.id}", group:"${f.group}", home:"${f.home}", away:"${f.away}", kickoff:"${f.kickoff}"}`;
  let chunk = "";
  let prevLabel = null;
  for (const f of additions) {
    if (f.group !== prevLabel && !htmlText.includes(`group:"${f.group}"`)) {
      const comment = /^\d\/\d+$/.test(f.group) ? `${f.group} finału` : f.group;
      chunk += `${EOL}${EOL}  // ${comment}`;
    }
    chunk += EOL + line(f) + ",";
    prevLabel = f.group;
  }
  chunk = chunk.replace(/,$/, "");                 // last entry: no trailing comma

  // append after the current last entry (which has no trailing comma)
  const newHtml = htmlText.replace(/(const FIXTURES\s*=\s*\[)([\s\S]*?)(\n\];)/,
    (_, pre, mid, post) => pre + mid + "," + chunk + post);
  return { additions, newHtml };
}

// --- run -------------------------------------------------------------------
let resolved;
if (SELFTEST) {
  // fake: a fully-resolved quarterfinal to prove parsing/format/insertion
  resolved = [{ label: "1/4", home: "Morocco", away: "Argentina", kickoff: "2026-07-09T20:00:00Z" }];
} else {
  resolved = await collectFromEspn();
}

const { additions, newHtml } = buildAdditions(resolved, html);

if (additions.length === 0) {
  console.log("BRAK: brak nowych, w pełni rozstrzygniętych par do dodania.");
  process.exit(0);
}

console.log("Nowe pary:");
for (const f of additions) console.log(`  ${f.id} [${f.group}] ${f.home} - ${f.away}  ${f.kickoff}`);

if (DRY || SELFTEST) {
  const tail = newHtml.match(/(const FIXTURES[\s\S]*?\n\];)/)[1].split("\n").slice(-12).join("\n");
  console.log("\n--- ogon FIXTURES (podgląd, nic nie zapisano) ---\n" + tail);
  process.exit(0);
}

writeFileSync(HTML_PATH, newHtml);
console.log(`\nZAPISANO ${additions.length} nowych par do index.html`);
