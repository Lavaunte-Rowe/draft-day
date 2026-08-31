"use strict";
// This league's exact scoring rules (from the user's Yahoo league Scoring &
// Settings page), used to compute a "customPts" projection alongside the
// generic PPR one. Verified against Sleeper's projections payload this
// session — these are the raw stat fields that actually exist for free:
// offense: pass_yd/pass_td/pass_int/pass_2pt, rush_att/rush_yd/rush_td/rush_2pt,
// rec/rec_yd/rec_td/rec_2pt, fum_lost.
// IDP: idp_tkl_solo/idp_tkl_ast/idp_sack/idp_int/idp_ff/idp_fum_rec/idp_safe/idp_blk_kick.
// Kicker and DST are NOT computed — see UNCOMPUTABLE below for why.
//
// Categories the league scores that NO free data source provides a number
// for (not guessed, not approximated — just omitted from customPts):
const UNCOMPUTABLE = [
  "40+ yard passing/rushing/receiving TD and play bonuses",
  "Defensive/IDP touchdowns",
  "Pass defended (IDP)",
  "Tackles for loss (IDP)",
  "Extra point returned",
  "Fumbles not lost (only fumbles LOST are projectable)",
  "Kicker and team defense custom points aren't computed at all — Sleeper's projections don't break out 0-39 yard field goals or a full points/yards-allowed tier ladder, so both use the generic projection instead of a silently-incomplete custom one",
];

const SCORING = {
  passing: { ydsPerPt: 25, td: 6, int: -2, twoPt: 2, bonuses: [[400, 2], [500, 2]] },
  rushing: { ydsPerPt: 10, td: 6, twoPt: 2, bonuses: [[100, 2], [150, 1]] },
  receiving: { rec: 1, ydsPerPt: 10, td: 6, twoPt: 2, bonuses: [[100, 2], [175, 2]] },
  fumbleLost: -2,
  idp: {
    tackleSolo: 1,
    tackleAssist: 0.5,
    sack: 2,
    int: 3,
    forcedFumble: 2,
    fumbleRec: 2,
    safety: 2,
    blockKick: 2,
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SCORING, UNCOMPUTABLE };
}
