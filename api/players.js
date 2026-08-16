"use strict";

const { PLAYERS } = require("../data/players.js");
const overrides = require("../data/sleeper-overrides.json");
const { matchPlayers } = require("./_lib/match.js");

const SLEEPER_URL = "https://api.sleeper.app/v1/players/nfl";
const ADP_URL = "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=10&year=2026";

// Injury statuses Sleeper actually emits (Active/empty means no designation).
const INJURY_CODES = {
  Questionable: "Q",
  Doubtful: "D",
  Out: "O",
  "Injured Reserve": "IR",
  IR: "IR",
  PUP: "PUP",
  Suspended: "SUSP",
  NA: "NA",
};

// Fantasy Football Calculator's ADP set only covers ~260 players who see real
// live-draft volume — deep bench players legitimately have no live signal, so
// unmatched players just keep their curated static ADP (handled client-side).
async function fetchLiveAdp() {
  const res = await fetch(ADP_URL);
  if (!res.ok) throw new Error(`FFC ADP API responded ${res.status}`);
  const data = await res.json();
  const byId = {};
  for (const p of data.players || []) {
    byId[p.player_id] = { full_name: p.name, position: p.position, team: p.team, adp: p.adp };
  }
  const { matched } = matchPlayers(PLAYERS, byId, {});
  const liveAdp = {};
  for (const [internalId, ffcId] of Object.entries(matched)) {
    const fp = byId[ffcId];
    if (fp) liveAdp[internalId] = fp.adp;
  }
  return liveAdp;
}

module.exports = async (req, res) => {
  try {
    const sleeperRes = await fetch(SLEEPER_URL);
    if (!sleeperRes.ok) {
      throw new Error(`Sleeper API responded ${sleeperRes.status}`);
    }
    const sleeper = await sleeperRes.json();

    const { matched, unmatched } = matchPlayers(PLAYERS, sleeper, overrides);

    let liveAdp = {};
    try {
      liveAdp = await fetchLiveAdp();
    } catch (err) {
      console.warn("Live ADP fetch failed, falling back to consensus ADP only:", err);
    }

    const players = {};
    for (const [internalId, sleeperId] of Object.entries(matched)) {
      const sp = sleeper[sleeperId];
      if (!sp) continue;
      players[internalId] = {
        sleeper_id: sleeperId,
        injury_status: sp.injury_status ? (INJURY_CODES[sp.injury_status] || sp.injury_status) : null,
        depth_chart_position: sp.depth_chart_position || null,
        depth_chart_order: sp.depth_chart_order || null,
        years_exp: typeof sp.years_exp === "number" ? sp.years_exp : null,
      };
    }
    for (const [internalId, adp] of Object.entries(liveAdp)) {
      players[internalId] = { ...(players[internalId] || {}), live_adp: adp };
    }

    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=43200");
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      matchedCount: Object.keys(matched).length,
      unmatchedIds: unmatched,
      liveAdpMatchedCount: Object.keys(liveAdp).length,
      players,
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch/enrich player data", message: String(err && err.message || err) });
  }
};
