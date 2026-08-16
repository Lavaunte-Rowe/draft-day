"use strict";

// Internal PLAYERS use a few team abbreviations that don't always match Sleeper's.
const TEAM_ALIASES = {
  WSH: "WAS", WAS: "WSH",
  JAC: "JAX", JAX: "JAC",
};

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[.']/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return TEAM_ALIASES[a] === b || TEAM_ALIASES[b] === a;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// sleeperPlayers: raw Sleeper /v1/players/nfl payload, keyed by sleeper player_id.
// overrides: { [internalId]: sleeper_id } hand-maintained fixes, always take priority.
// Returns { matched: {internalId: sleeper_id}, unmatched: [internalId], ambiguous: [internalId] }
function matchPlayers(players, sleeperPlayers, overrides = {}) {
  const byNormName = new Map();
  const defByTeam = new Map();

  for (const [sid, p] of Object.entries(sleeperPlayers)) {
    if (p.position === "DEF") {
      defByTeam.set(p.team, sid);
      continue;
    }
    const full = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
    if (!full) continue;
    const norm = normalizeName(full);
    if (!byNormName.has(norm)) byNormName.set(norm, []);
    byNormName.get(norm).push(sid);
  }

  const matched = {};
  const unmatched = [];
  const ambiguous = [];

  for (const player of players) {
    if (overrides[player.id]) {
      matched[player.id] = overrides[player.id];
      continue;
    }

    if (player.p === "DST") {
      const sid = defByTeam.get(player.t);
      if (sid) matched[player.id] = sid;
      else unmatched.push(player.id);
      continue;
    }

    const norm = normalizeName(player.n);
    const candidates = byNormName.get(norm) || [];
    const posMatch = (sp) => sp.position === player.p || (sp.fantasy_positions || []).includes(player.p);
    const strong = candidates.filter((sid) => {
      const sp = sleeperPlayers[sid];
      return posMatch(sp) && (teamsMatch(sp.team, player.t) || player.t === "FA");
    });

    if (strong.length === 1) {
      matched[player.id] = strong[0];
    } else if (strong.length > 1) {
      matched[player.id] = strong[0];
      ambiguous.push(player.id);
    } else if (candidates.length === 1) {
      matched[player.id] = candidates[0];
      ambiguous.push(player.id); // name unique but team/pos disagreed (trade, stale internal data, etc.)
    } else {
      let best = null, bestDist = Infinity;
      for (const [sid, sp] of Object.entries(sleeperPlayers)) {
        if (!posMatch(sp)) continue;
        const spFull = sp.full_name || `${sp.first_name || ""} ${sp.last_name || ""}`.trim();
        if (!spFull) continue;
        const dist = levenshtein(norm, normalizeName(spFull));
        if (dist < bestDist) { bestDist = dist; best = sid; }
      }
      const threshold = Math.max(2, Math.floor(norm.length * 0.2));
      if (best && bestDist <= threshold) {
        matched[player.id] = best;
        ambiguous.push(player.id);
      } else {
        unmatched.push(player.id);
      }
    }
  }

  return { matched, unmatched, ambiguous };
}

module.exports = { normalizeName, teamsMatch, levenshtein, matchPlayers, TEAM_ALIASES };
