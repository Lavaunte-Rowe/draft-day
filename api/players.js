"use strict";

const { PLAYERS } = require("../data/players.js");
const overrides = require("../data/sleeper-overrides.json");
const { matchPlayers } = require("./_lib/match.js");

const SLEEPER_URL = "https://api.sleeper.app/v1/players/nfl";

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

module.exports = async (req, res) => {
  try {
    const sleeperRes = await fetch(SLEEPER_URL);
    if (!sleeperRes.ok) {
      throw new Error(`Sleeper API responded ${sleeperRes.status}`);
    }
    const sleeper = await sleeperRes.json();

    const { matched, unmatched } = matchPlayers(PLAYERS, sleeper, overrides);

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

    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=43200");
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      matchedCount: Object.keys(matched).length,
      unmatchedIds: unmatched,
      players,
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch/enrich player data", message: String(err && err.message || err) });
  }
};
