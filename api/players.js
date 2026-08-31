"use strict";

const { PLAYERS } = require("../data/players.js");
const overrides = require("../data/sleeper-overrides.json");
const { matchPlayers } = require("./_lib/match.js");
const { computeCustomPts } = require("./_lib/scoring.js");

const SLEEPER_URL = "https://api.sleeper.app/v1/players/nfl";
const ADP_URL = "https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=10&year=2026";
const PROJECTIONS_URL = "https://api.sleeper.com/projections/nfl/2026?season_type=regular";
const IDP_POSITIONS = ["CB", "DL", "SS", "DE", "DB", "DT", "LB", "NT"];
const PROJ_FIELDS = [
  "pts_ppr", "gp",
  "pass_yd", "pass_td", "pass_int", "pass_2pt",
  "rush_att", "rush_yd", "rush_td", "rush_2pt",
  "rec", "rec_yd", "rec_td", "rec_2pt",
  "fum_lost", "sack", "int", "fum_rec",
  "idp_tkl_solo", "idp_tkl_ast", "idp_sack", "idp_int", "idp_ff", "idp_fum_rec", "idp_safe", "idp_blk_kick",
];

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

// Free, undocumented but public Sleeper endpoint (season-long projections,
// sourced from Rotowire). Keyed by the same Sleeper player_id we already
// match against for injury/depth data — no separate name-matching needed.
async function fetchProjections() {
  const res = await fetch(PROJECTIONS_URL);
  if (!res.ok) throw new Error(`Sleeper projections API responded ${res.status}`);
  const data = await res.json();
  const byId = {};
  for (const entry of data) {
    if (!entry.player_id || !entry.stats) continue;
    byId[entry.player_id] = entry.stats;
  }
  return byId;
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

    let projById = {};
    try {
      projById = await fetchProjections();
    } catch (err) {
      console.warn("Projections fetch failed, continuing without them:", err);
    }

    const playersById = {};
    for (const p of PLAYERS) playersById[p.id] = p;

    const players = {};
    let projMatchedCount = 0;
    for (const [internalId, sleeperId] of Object.entries(matched)) {
      const sp = sleeper[sleeperId];
      if (!sp) continue;
      const pr = projById[sleeperId];
      const position = playersById[internalId] && playersById[internalId].p;
      let proj = null;
      if (pr && typeof pr.pts_ppr === "number") {
        proj = {};
        for (const f of PROJ_FIELDS) proj[f] = typeof pr[f] === "number" ? pr[f] : null;
        proj.customPts = computeCustomPts(pr, position);
        projMatchedCount++;
      }
      players[internalId] = {
        sleeper_id: sleeperId,
        injury_status: sp.injury_status ? (INJURY_CODES[sp.injury_status] || sp.injury_status) : null,
        depth_chart_position: sp.depth_chart_position || null,
        depth_chart_order: sp.depth_chart_order || null,
        years_exp: typeof sp.years_exp === "number" ? sp.years_exp : null,
        proj,
      };
      // FFC has no IDP coverage at all — IDP players get their live ADP from
      // Sleeper's own IDP-specific ADP field instead (adp_idp), sourced from
      // the same projections payload already fetched above.
      if (IDP_POSITIONS.includes(position) && pr && typeof pr.adp_idp === "number" && pr.adp_idp < 900) {
        players[internalId].live_adp = pr.adp_idp;
      }
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
      projMatchedCount,
      players,
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch/enrich player data", message: String(err && err.message || err) });
  }
};
