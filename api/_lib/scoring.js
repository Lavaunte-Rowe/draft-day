"use strict";
const { SCORING } = require("../../data/league-scoring.js");

function sumBonuses(yards, bonuses) {
  if (typeof yards !== "number") return 0;
  let total = 0;
  for (const [threshold, pts] of bonuses) if (yards >= threshold) total += pts;
  return total;
}
function num(v) {
  return typeof v === "number" ? v : 0;
}

// Offense (QB/RB/WR/TE): full raw-stat recompute under this league's exact
// rules. Kicker and DST are intentionally NOT computed here — Sleeper's
// projections don't expose enough of their raw stats (no 0-39 yard FG
// bucket, no points/yards-allowed tier breakdown) to build an honest custom
// number for either, so the app falls back to the generic projection for
// both instead of presenting a silently-incomplete "custom" figure.
function computeOffenseCustomPts(s) {
  if (!s) return null;
  const p = SCORING.passing, r = SCORING.rushing, c = SCORING.receiving;
  let pts = 0;
  let hasAny = false;
  if (typeof s.pass_yd === "number" || typeof s.pass_td === "number") {
    hasAny = true;
    pts += num(s.pass_yd) / p.ydsPerPt;
    pts += num(s.pass_td) * p.td;
    pts += num(s.pass_int) * p.int;
    pts += num(s.pass_2pt) * p.twoPt;
    pts += sumBonuses(s.pass_yd, p.bonuses);
  }
  if (typeof s.rush_yd === "number" || typeof s.rush_att === "number") {
    hasAny = true;
    pts += num(s.rush_yd) / r.ydsPerPt;
    pts += num(s.rush_td) * r.td;
    pts += num(s.rush_2pt) * r.twoPt;
    pts += sumBonuses(s.rush_yd, r.bonuses);
  }
  if (typeof s.rec === "number" || typeof s.rec_yd === "number") {
    hasAny = true;
    pts += num(s.rec) * c.rec;
    pts += num(s.rec_yd) / c.ydsPerPt;
    pts += num(s.rec_td) * c.td;
    pts += num(s.rec_2pt) * c.twoPt;
    pts += sumBonuses(s.rec_yd, c.bonuses);
  }
  if (!hasAny) return null;
  pts += num(s.fum_lost) * SCORING.fumbleLost;
  return Math.round(pts * 10) / 10;
}

function computeIdpCustomPts(s) {
  if (!s) return null;
  if (typeof s.idp_tkl_solo !== "number" && typeof s.idp_sack !== "number" && typeof s.idp_int !== "number") return null;
  const w = SCORING.idp;
  let pts = 0;
  pts += num(s.idp_tkl_solo) * w.tackleSolo;
  pts += num(s.idp_tkl_ast) * w.tackleAssist;
  pts += num(s.idp_sack) * w.sack;
  pts += num(s.idp_int) * w.int;
  pts += num(s.idp_ff) * w.forcedFumble;
  pts += num(s.idp_fum_rec) * w.fumbleRec;
  pts += num(s.idp_safe) * w.safety;
  pts += num(s.idp_blk_kick) * w.blockKick;
  return Math.round(pts * 10) / 10;
}

// position: internal PLAYERS `p` field value (RB/WR/QB/TE for offense,
// CB/DL/SS/DE/DB/DT/LB/NT for IDP, K/DST intentionally return null).
function computeCustomPts(rawStats, position) {
  if (["RB", "WR", "QB", "TE"].includes(position)) return computeOffenseCustomPts(rawStats);
  if (["CB", "DL", "SS", "DE", "DB", "DT", "LB", "NT"].includes(position)) return computeIdpCustomPts(rawStats);
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeCustomPts };
}
