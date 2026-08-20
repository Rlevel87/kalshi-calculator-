/* =======================================================================
   Kalshi College Football Value Model.
   Team composite: CollegeFootballData.com (CFBD)'s per-team PPA (their EPA
   equivalent) and season stats, proxied server-side -- CFBD requires a free
   API key, which stays server-side only and is never sent to the browser.
   Depth chart: no free source (ESPN included) publishes official college
   depth charts, so this is built from real season production instead --
   CFBD's play-involvement % for offensive skill positions, and tackle
   volume for defense -- clearly labeled as an estimate, not an official
   chart. Offensive line has no individual signal anywhere (same dead end
   as the NFL model hit), so it's left out rather than faked.
   Player click-to-stats reuses the same per-team CFBD pulls already made
   for the depth chart -- no extra request when you click a name.
   Everything else (market inputs, trade log, matchup data/accuracy
   tracking) mirrors the NFL and baseball models' proven pattern.
   ======================================================================= */

// College football seasons are named the same way NFL ones are (the year they kick off in),
// so the same Jan/Feb rollover rule applies -- matches server.py's _current_cfb_season().
const CFB_SEASON_YEAR = (function () {
  const now = new Date();
  const m = now.getUTCMonth() + 1;
  return m >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
})();
const CFB_CURRENT_SEASON = String(CFB_SEASON_YEAR);
const CFB_FALLBACK_SEASON = String(CFB_SEASON_YEAR - 1);

let lastCalc = null;
let cfbTeamsCache = null;
let lastFetchedSeason = { A: null, B: null };
// Every CFBD per-team stat pull made during "Fetch live data" -- reused both to build the
// estimated depth chart AND to answer a player click with zero extra network calls.
// Shape: { A: { season, usage: [...], passing: [...], ... }, B: {...} }
let cfbPlayerData = { A: null, B: null };

function $(id) { return document.getElementById(id); }
function val(id) { return parseFloat($(id).value); }
function txt(id) { return $(id).value.trim(); }

/* ---------------------------- math helpers (identical to the NFL/baseball models) ---------------------------- */
function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
function fmtPts(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + ' pts'; }
function z(value, mean, sd) { return sd ? (value - mean) / sd : 0; }
function logistic(x, scale) { return 1 / (1 + Math.pow(10, -x / scale)); }
function log5(pA, pB) { const den = pA + pB - 2 * pA * pB; return den <= 0 ? 0.5 : (pA - pA * pB) / den; }
function kellyFraction(p, price) {
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price, q = 1 - p;
  return Math.max(0, (b * p - q) / b);
}
function safeDiv(a, b) { return b ? a / b : 0; }
function fmtNum(x, d) { return (x === null || x === undefined || isNaN(x)) ? '—' : Number(x).toFixed(d === undefined ? 1 : d); }
function weights(prefix, keys) {
  const w = {};
  let sum = 0;
  keys.forEach(k => { w[k] = val(prefix + k) || 0; sum += w[k]; });
  if (sum > 0) keys.forEach(k => { w[k] /= sum; });
  return w;
}

/* ---------------------------- server proxy fetch helpers ---------------------------- */
async function fetchJson(url) {
  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.indexOf('application/json') === -1) {
    throw new Error('Server isn\'t running — start it via the "Kalshi Value Models" desktop shortcut, or run "python server.py" from the kalshi-calculator- folder.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || ('Server returned ' + res.status));
  return data;
}
async function espnCfbGet(path) { return fetchJson('/api/espn/cfb-site' + path); }
async function cfbdGet(path) { return fetchJson('/api/cfbd' + path); }
async function cfbTeamSummaryGet(team, season) {
  const qs = season ? ('?season=' + encodeURIComponent(season)) : '';
  return fetchJson('/api/cfb/team-summary/' + encodeURIComponent(team) + qs);
}

/* ---------------------------- team resolution ---------------------------- */
async function getCfbTeams() {
  if (cfbTeamsCache) return cfbTeamsCache;
  cfbTeamsCache = await cfbdGet('/teams/fbs?year=' + CFB_CURRENT_SEASON);
  return cfbTeamsCache;
}
function teamFullName(t) { return t.school + (t.mascot ? ' ' + t.mascot : ''); }
function findCfbTeam(query, teams) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = teams.find(function (t) {
    return (t.abbreviation || '').toLowerCase() === q || t.school.toLowerCase() === q ||
      (t.mascot || '').toLowerCase() === q || teamFullName(t).toLowerCase() === q;
  });
  if (exact) return exact;
  return teams.find(function (t) {
    return t.school.toLowerCase().includes(q) || (t.mascot || '').toLowerCase().includes(q);
  }) || null;
}
function applyTeamBadge(side, team) {
  document.documentElement.style.setProperty('--team-' + side.toLowerCase() + '-color', team.color || '#4fb0c6');
  $('mbName' + side).textContent = teamFullName(team);
  const logo = $('mbLogo' + side);
  logo.classList.remove('loaded');
  logo.onload = function () { logo.classList.add('loaded'); };
  logo.onerror = function () { logo.classList.remove('loaded'); };
  logo.src = (team.logos && team.logos[0]) || '';
  logo.alt = teamFullName(team) + ' logo';
}
async function resolveAndBadge(side) {
  const name = txt(side === 'A' ? 'teamAName' : 'teamBName');
  if (!name) return;
  try {
    const teams = await getCfbTeams();
    const team = findCfbTeam(name, teams);
    if (team) applyTeamBadge(side, team);
  } catch (e) { /* cosmetic only */ }
}

/* ---------------------------- injuries (league-wide, one call, matched by name) ---------------------------- */
// CFBD players and ESPN's injury feed don't share an id system, so injuries are matched by
// normalized name -- imperfect (a name collision would misattribute) but the best available
// option, and college injury reports are sparse enough that this is a minor risk in practice.
function normalizeName(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
const INACTIVE_STATUSES = ['out', 'injured reserve', 'ir', 'suspended', 'pup', 'physically unable to perform', 'reserve/pup'];

async function getCfbInjuriesByName() {
  const data = await espnCfbGet('/injuries');
  const map = {};
  (data.injuries || []).forEach(function (teamGroup) {
    (teamGroup.injuries || []).forEach(function (inj) {
      const name = inj.athlete && inj.athlete.displayName;
      if (!name) return;
      const statusText = inj.status || (inj.type && inj.type.description) || 'Unknown';
      map[normalizeName(name)] = {
        status: statusText,
        detail: inj.details && inj.details.type,
        inactive: INACTIVE_STATUSES.indexOf(statusText.toLowerCase()) !== -1
      };
    });
  });
  return map;
}

/* ---------------------------- per-team CFBD player data (depth chart + click-to-stats) ---------------------------- */
const STAT_CATEGORIES = ['passing', 'rushing', 'receiving', 'defensive', 'kicking', 'punting'];

async function getCfbPlayerData(school, season) {
  const [usage, ...catResults] = await Promise.all(
    [cfbdGet('/player/usage?year=' + season + '&team=' + encodeURIComponent(school))].concat(
      STAT_CATEGORIES.map(function (cat) {
        return cfbdGet('/stats/player/season?year=' + season + '&team=' + encodeURIComponent(school) + '&category=' + cat);
      })
    )
  );
  const data = { season: season, usage: usage || [] };
  STAT_CATEGORIES.forEach(function (cat, i) { data[cat] = catResults[i] || []; });
  return data;
}

// Top N by usage% within one offensive skill position -- the closest real signal to "who's
// actually starting" that exists for college football (based on real season play involvement,
// not a paper listing).
function topByUsage(usageRows, position, n) {
  return usageRows.filter(function (p) { return p.position === position; })
    .slice().sort(function (a, b) { return (b.usage.overall || 0) - (a.usage.overall || 0); })
    .slice(0, n)
    .map(function (p) { return { name: p.name, position: p.position, value: p.usage.overall || 0 }; });
}
// Top N by total tackles within one defensive position -- approximate involvement signal
// (CFBD has no usage% for defense), same idea, coarser precision.
function topByTackles(defensiveRows, position, n) {
  const totals = defensiveRows.filter(function (r) { return r.position === position && r.statType === 'TOT'; });
  return totals.slice().sort(function (a, b) { return parseFloat(b.stat) - parseFloat(a.stat); })
    .slice(0, n)
    .map(function (r) { return { name: r.player, position: r.position, value: parseFloat(r.stat) }; });
}

const OFFENSE_SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const DEFENSE_POSITIONS = ['DL', 'DE', 'DT', 'EDGE', 'LB', 'CB', 'S', 'DB'];

function buildEstimatedDepthChart(playerData) {
  const seenDefPos = new Set((playerData.defensive || []).map(function (r) { return r.position; }));
  const offense = OFFENSE_SKILL_POSITIONS.map(function (pos) {
    return { pos: pos, entries: topByUsage(playerData.usage, pos, 3) };
  }).filter(function (g) { return g.entries.length; });
  const defense = DEFENSE_POSITIONS.filter(function (pos) { return seenDefPos.has(pos); }).map(function (pos) {
    return { pos: pos, entries: topByTackles(playerData.defensive, pos, 3) };
  }).filter(function (g) { return g.entries.length; });
  return { offense: offense, defense: defense };
}

/* ---------------------------- depth chart rendering ---------------------------- */
function renderCfbDepthChartGrid(nameA, dcA, nameB, dcB, injuryMap) {
  const el = $('depthChartGrid');
  function rowsHtml(groups, metricLabel) {
    return groups.map(function (g) {
      const names = g.entries.map(function (e, i) {
        const inj = injuryMap[normalizeName(e.name)];
        const cls = i === 0 ? (inj && inj.inactive ? 'inactive' : 'starter') : 'backup';
        const tag = inj ? '<span class="injury-tag" title="' + (inj.detail || '') + '">' + inj.status + '</span>' : '';
        return '<span class="depth-player clickable ' + cls + '" data-player-name="' + escapeAttr(e.name) +
          '" title="Click to see season stats">' + e.name +
          ' <span class="usage-note">(' + metricLabel(e.value) + ')</span>' + tag + '</span>';
      }).join(' &middot; ');
      return '<div class="depth-pos-row"><span class="depth-pos-label">' + g.pos + '</span>' + (names || '<span class="empty-note">—</span>') + '</div>';
    }).join('');
  }
  function teamBlock(name, dc) {
    return '<div><h3 style="margin:0 0 8px; font-size:13px; color:var(--ink-muted);">' + name + ' &mdash; Offense (by usage)</h3>' +
      rowsHtml(dc.offense, function (v) { return (v * 100).toFixed(0) + '% usage'; }) +
      '<h3 style="margin:14px 0 8px; font-size:13px; color:var(--ink-muted);">' + name + ' &mdash; Defense (by tackles)</h3>' +
      rowsHtml(dc.defense, function (v) { return v.toFixed(0) + ' tkl'; }) + '</div>';
  }
  el.innerHTML = teamBlock(nameA, dcA) + teamBlock(nameB, dcB);
}
function escapeAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

/* ---------------------------- player stats modal (click a depth chart name) ---------------------------- */
// Unlike the NFL model, no fetch happens here -- everything needed is already sitting in
// cfbPlayerData from the main "Fetch live data" pull, so this is a pure client-side lookup.
function findPlayerCategoryRows(name) {
  const norm = normalizeName(name);
  const out = {};
  ['A', 'B'].forEach(function (side) {
    const data = cfbPlayerData[side];
    if (!data) return;
    STAT_CATEGORIES.forEach(function (cat) {
      (data[cat] || []).forEach(function (r) {
        if (normalizeName(r.player) === norm) {
          out[cat] = out[cat] || [];
          out[cat].push(r);
        }
      });
    });
  });
  return out;
}
function openPlayerStatsModal(playerName) {
  $('playerStatsModal').classList.remove('hidden');
  $('playerStatsName').textContent = playerName;
  $('playerStatsPos').textContent = 'Season ' + (lastFetchedSeason.A || lastFetchedSeason.B || CFB_CURRENT_SEASON);
  const rowsByCat = findPlayerCategoryRows(playerName);
  let html = '';
  STAT_CATEGORIES.forEach(function (cat) {
    const rows = rowsByCat[cat];
    if (!rows || !rows.length) return;
    const tableRows = rows.map(function (r) { return '<tr><td>' + r.statType + '</td><td>' + r.stat + '</td></tr>'; }).join('');
    html += '<div class="player-stat-cat"><h4>' + cat.charAt(0).toUpperCase() + cat.slice(1) + '</h4><table class="player-stat-table"><tbody>' + tableRows + '</tbody></table></div>';
  });
  $('playerStatsBody').innerHTML = html || '<div class="fetch-status">No season stats found for this player.</div>';
}
function closePlayerStatsModal() { $('playerStatsModal').classList.add('hidden'); }
document.getElementById('depthChartGrid').addEventListener('click', function (e) {
  const el = e.target.closest('.depth-player');
  if (!el || !el.dataset.playerName) return;
  openPlayerStatsModal(el.dataset.playerName);
});

/* ---------------------------- main fetch orchestration ---------------------------- */
async function fetchMatchup() {
  const btn = $('fetchBtn');
  const status = $('fetchStatus');
  const nameA = txt('teamAName'), nameB = txt('teamBName');
  if (!nameA || !nameB) { status.textContent = 'Enter both team names first.'; return; }

  btn.disabled = true;
  try {
    status.textContent = 'Looking up teams…';
    const teams = await getCfbTeams();
    const teamA = findCfbTeam(nameA, teams), teamB = findCfbTeam(nameB, teams);
    if (!teamA || !teamB) {
      status.textContent = 'Could not match one or both team names — try the exact school name (e.g. "Ohio State").';
      return;
    }
    $('teamAName').value = teamFullName(teamA);
    $('teamBName').value = teamFullName(teamB);
    applyTeamBadge('A', teamA);
    applyTeamBadge('B', teamB);

    status.textContent = 'Fetching team season stats…';
    const [summaryA, summaryB] = await Promise.all([
      cfbTeamSummaryGet(teamA.school).catch(function () { return null; }),
      cfbTeamSummaryGet(teamB.school).catch(function () { return null; })
    ]);
    applyTeamSummaryToInputs('A', summaryA);
    applyTeamSummaryToInputs('B', summaryB);

    const season = (summaryA && summaryA.season) || (summaryB && summaryB.season) || CFB_CURRENT_SEASON;
    status.textContent = 'Fetching player usage, season stats, and injuries…';
    const [playerDataA, playerDataB, injuryMap] = await Promise.all([
      getCfbPlayerData(teamA.school, season),
      getCfbPlayerData(teamB.school, season),
      getCfbInjuriesByName()
    ]);
    cfbPlayerData.A = playerDataA;
    cfbPlayerData.B = playerDataB;
    const dcA = buildEstimatedDepthChart(playerDataA), dcB = buildEstimatedDepthChart(playerDataB);
    renderCfbDepthChartGrid(teamFullName(teamA), dcA, teamFullName(teamB), dcB, injuryMap);
    $('depthChartStatus').textContent = '✓ Estimated depth chart (by season usage/tackles, ' + season + ') and injury report loaded — not an official chart, see note above.';

    recalc();
    status.textContent = '✓ Loaded ' + teamFullName(teamA) + ' vs ' + teamFullName(teamB) + '. Team stats: ' + season + ' season.';
  } catch (err) {
    status.textContent = 'Fetch failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function applyTeamSummaryToInputs(side, s) {
  if (!s) return;
  lastFetchedSeason[side] = s.season;
  $('epaDiff' + side).value = fmtNum(s.epaDifferential, 3);
  $('pointsFor' + side).value = fmtNum(s.pointsFor, 1);
  $('pointsAgainst' + side).value = fmtNum(s.pointsAgainst, 1);
  $('turnoverMargin' + side).value = fmtNum(s.turnoverMargin, 3);
  $('offPassEpa' + side).value = fmtNum(s.offPassingEpa, 3);
  $('defEpaAllowed' + side).value = fmtNum(s.defEpaAllowed, 3);
  $('yardsDiff' + side).value = fmtNum(s.totalYardsDiff, 1);
  $('offRushEpa' + side).value = fmtNum(s.offRushEpa, 3);
  $('offRushYards' + side).value = fmtNum(s.offRushYards, 1);
  $('defRushYards' + side).value = fmtNum(s.defRushYardsAllowed, 1);
  $('offTotalYards' + side).value = fmtNum(s.offTotalYards, 1);
  $('defTotalYards' + side).value = fmtNum(s.defTotalYardsAllowed, 1);
  $('defPassYards' + side).value = fmtNum(s.defPassYardsAllowed, 1);
  $('offPassYards' + side).value = fmtNum(s.offPassingYards, 1);
}

/* ---------------------------- team composite (Team Strength Index) + recalc ---------------------------- */
const TSI_KEYS = ['EpaDiff', 'PointsFor', 'PointsAgainst', 'TurnoverMargin', 'OffPassEpa', 'DefEpaAllowed',
  'YardsDiff', 'OffRushEpa', 'OffRushYards', 'DefRushYards', 'OffTotalYards', 'DefTotalYards', 'DefPassYards', 'OffPassYards'];

function compositeTSI(side, w, base) {
  const g = function (key) { return val(key + side); };
  const zEpaDiff = z(g('epaDiff'), base.epaDiffMean, base.epaDiffSd);
  const zPointsFor = z(g('pointsFor'), base.pointsForMean, base.pointsForSd);
  const zPointsAgainst = -z(g('pointsAgainst'), base.pointsAgainstMean, base.pointsAgainstSd);
  const zTurnoverMargin = z(g('turnoverMargin'), 0, base.turnoverMarginSd);
  const zOffPassEpa = z(g('offPassEpa'), base.offPassEpaMean, base.offPassEpaSd);
  const zDefEpaAllowed = -z(g('defEpaAllowed'), base.defEpaAllowedMean, base.defEpaAllowedSd);
  const zYardsDiff = z(g('yardsDiff'), base.yardsDiffMean, base.yardsDiffSd);
  const zOffRushEpa = z(g('offRushEpa'), base.offRushEpaMean, base.offRushEpaSd);
  const zOffRushYards = z(g('offRushYards'), base.offRushYardsMean, base.offRushYardsSd);
  const zDefRushYards = -z(g('defRushYards'), base.defRushYardsMean, base.defRushYardsSd);
  const zOffTotalYards = z(g('offTotalYards'), base.offTotalYardsMean, base.offTotalYardsSd);
  const zDefTotalYards = -z(g('defTotalYards'), base.defTotalYardsMean, base.defTotalYardsSd);
  const zDefPassYards = -z(g('defPassYards'), base.defPassYardsMean, base.defPassYardsSd);
  const zOffPassYards = z(g('offPassYards'), base.offPassYardsMean, base.offPassYardsSd);

  return w.EpaDiff * zEpaDiff + w.PointsFor * zPointsFor + w.PointsAgainst * zPointsAgainst +
    w.TurnoverMargin * zTurnoverMargin + w.OffPassEpa * zOffPassEpa + w.DefEpaAllowed * zDefEpaAllowed +
    w.YardsDiff * zYardsDiff + w.OffRushEpa * zOffRushEpa + w.OffRushYards * zOffRushYards +
    w.DefRushYards * zDefRushYards + w.OffTotalYards * zOffTotalYards + w.DefTotalYards * zDefTotalYards +
    w.DefPassYards * zDefPassYards + w.OffPassYards * zOffPassYards;
}

function recalc() {
  const nameA = txt('teamAName') || 'Team A', nameB = txt('teamBName') || 'Team B';
  $('cardATitle').textContent = nameA + ' — ' + (lastFetchedSeason.A ? lastFetchedSeason.A + ' ' : '') + 'Season Stats';
  $('cardBTitle').textContent = nameB + ' — ' + (lastFetchedSeason.B ? lastFetchedSeason.B + ' ' : '') + 'Season Stats';
  $('resATitle').textContent = nameA;
  $('resBTitle').textContent = nameB;

  const w = weights('w', TSI_KEYS);
  const base = {};
  ['epaDiffMean', 'epaDiffSd', 'pointsForMean', 'pointsForSd', 'pointsAgainstMean', 'pointsAgainstSd', 'turnoverMarginSd',
    'offPassEpaMean', 'offPassEpaSd', 'defEpaAllowedMean', 'defEpaAllowedSd', 'yardsDiffMean', 'yardsDiffSd',
    'offRushEpaMean', 'offRushEpaSd', 'offRushYardsMean', 'offRushYardsSd', 'defRushYardsMean', 'defRushYardsSd',
    'offTotalYardsMean', 'offTotalYardsSd', 'defTotalYardsMean', 'defTotalYardsSd', 'defPassYardsMean', 'defPassYardsSd',
    'offPassYardsMean', 'offPassYardsSd'].forEach(function (k) { base[k] = val(k); });
  const scale = val('scale');

  const tsiA = compositeTSI('A', w, base);
  const tsiB = compositeTSI('B', w, base);
  const impliedA = logistic(tsiA, scale), impliedB = logistic(tsiB, scale);
  const modelA = log5(impliedA, impliedB), modelB = 1 - modelA;

  const priceACents = val('priceA');
  let priceBCents = val('priceB');
  if (isNaN(priceBCents)) priceBCents = 100 - priceACents;
  const rawA = priceACents / 100, rawB = priceBCents / 100;
  const overround = rawA + rawB;
  const marketA = overround > 0 ? rawA / overround : 0.5;
  const marketB = 1 - marketA;

  $('modelAVal').textContent = fmtPct(modelA); $('modelBVal').textContent = fmtPct(modelB);
  $('marketAVal').textContent = fmtPct(marketA); $('marketBVal').textContent = fmtPct(marketB);
  $('modelABar').style.width = (modelA * 100) + '%'; $('modelBBar').style.width = (modelB * 100) + '%';
  $('marketABar').style.width = (marketA * 100) + '%'; $('marketBBar').style.width = (marketB * 100) + '%';

  const edgeA = modelA - marketA, edgeB = modelB - marketB;
  const threshold = val('edgeThreshold') / 100;
  const kellyFrac = val('kellyFrac'), bankroll = val('bankroll');

  const banner = $('recBanner'), recMain = $('recMain'), recEdgeVal = $('recEdgeVal');
  const edgeVal = $('edgeVal'), evVal = $('evVal'), evSub = $('evSub'), kellyVal = $('kellyVal'), kellySub = $('kellySub');

  let side, edge, price, model, name;
  if (edgeA >= edgeB) { side = 'A'; edge = edgeA; price = rawA; model = modelA; name = nameA; }
  else { side = 'B'; edge = edgeB; price = rawB; model = modelB; name = nameB; }

  edgeVal.textContent = fmtPts(edge);
  const ev = model - price;
  evVal.textContent = (ev >= 0 ? '+$' : '-$') + Math.abs(ev).toFixed(3);
  evSub.textContent = 'per $1 staked on ' + name;

  let stakeFrac = 0;
  if (edge >= threshold) {
    banner.className = 'rec-banner pos';
    recMain.textContent = 'Buy ' + name + ' Yes';
    recEdgeVal.textContent = fmtPts(edge);
    stakeFrac = kellyFraction(model, price) * kellyFrac;
    kellyVal.textContent = (stakeFrac * 100).toFixed(1) + '%';
    kellySub.textContent = '≈ $' + (stakeFrac * bankroll).toFixed(2) + ' of bankroll (fractional Kelly)';
  } else if (edge <= -threshold) {
    banner.className = 'rec-banner neg';
    recMain.textContent = 'No trade — market looks ahead of the model';
    recEdgeVal.textContent = fmtPts(edge);
    kellyVal.textContent = '$0.00'; kellySub.textContent = 'no positive-EV side found above threshold';
  } else {
    banner.className = 'rec-banner';
    recMain.textContent = 'Pass — edge below threshold';
    recEdgeVal.textContent = fmtPts(edge);
    kellyVal.textContent = '$0.00'; kellySub.textContent = 'edge too small to act on';
  }

  lastCalc = {
    nameA: nameA, nameB: nameB, side: side, edge: edge, price: price, model: model, stakeFrac: stakeFrac, bankroll: bankroll,
    modelA: modelA, modelB: modelB, marketA: marketA, marketB: marketB
  };
  TSI_KEYS.forEach(function (k) {
    const inputKey = k.charAt(0).toLowerCase() + k.slice(1);
    lastCalc[inputKey + 'A'] = val(inputKey + 'A');
    lastCalc[inputKey + 'B'] = val(inputKey + 'B');
  });
}

/* ---------------------------- Trade log (identical pattern to the other models) ---------------------------- */
const LOG_KEY = 'kalshiCfbTradeLog';
function loadLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch (e) { return []; } }
function saveLog(entries) { localStorage.setItem(LOG_KEY, JSON.stringify(entries)); }

function logCurrentTrade() {
  if (!lastCalc) { alert('Fetch both teams\' data first so there\'s a calculated price and edge to log.'); return; }
  const betInput = $('betAmount');
  const stake = parseFloat(betInput.value);
  if (!stake || stake <= 0) { alert('Enter how much you\'re wagering first.'); return; }
  const entries = loadLog();
  entries.push({
    id: Date.now(), date: new Date().toISOString().slice(0, 10),
    matchup: lastCalc.nameA + ' vs ' + lastCalc.nameB,
    side: lastCalc.side === 'A' ? lastCalc.nameA : lastCalc.nameB,
    price: lastCalc.price, model: lastCalc.model, edge: lastCalc.edge,
    stakeDollars: stake, result: 'pending'
  });
  saveLog(entries);
  betInput.value = '';
  renderLog();
}
function exportLog() {
  const blob = new Blob([JSON.stringify(loadLog(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'kalshi-cfb-trade-log-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function importLog(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('not an array');
      const existing = loadLog();
      const existingIds = new Set(existing.map(function (e) { return e.id; }));
      saveLog(existing.concat(imported.filter(function (e) { return !existingIds.has(e.id); })));
      renderLog();
      alert('Imported ' + imported.length + ' entries (merged; duplicates skipped).');
    } catch (err) { alert('Could not read that file as a trade log export.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}
function setTradeResult(id, result) {
  const entries = loadLog();
  const e = entries.find(function (x) { return x.id === id; });
  if (e) e.result = result;
  saveLog(entries); renderLog();
}
function deleteTrade(id) { saveLog(loadLog().filter(function (x) { return x.id !== id; })); renderLog(); }
function tradePL(entry) {
  if (entry.result === 'win') return entry.stakeDollars * (1 - entry.price) / entry.price;
  if (entry.result === 'loss') return -entry.stakeDollars;
  return null;
}
function renderLog() {
  const entries = loadLog();
  const tbody = $('logTbody');
  tbody.innerHTML = '';
  let totalPL = 0, settled = 0, wins = 0;
  entries.slice().reverse().forEach(function (e) {
    const pl = tradePL(e);
    const toWin = e.stakeDollars * (1 - e.price) / e.price;
    if (pl !== null) { settled++; if (pl > 0) wins++; totalPL += pl; }
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + e.date + '</td><td>' + e.matchup + '</td><td>' + e.side + '</td>' +
      '<td>' + Math.round(e.price * 100) + '¢</td><td>' + (e.model * 100).toFixed(1) + '%</td>' +
      '<td>' + (e.edge >= 0 ? '+' : '') + (e.edge * 100).toFixed(1) + ' pts</td>' +
      '<td>$' + e.stakeDollars.toFixed(2) + '</td><td>+$' + toWin.toFixed(2) + '</td><td></td><td></td><td></td>';
    const select = document.createElement('select');
    [['pending', 'pending'], ['win', 'win'], ['loss', 'loss']].forEach(function (opt) {
      const o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1];
      if (opt[0] === e.result) o.selected = true; select.appendChild(o);
    });
    select.addEventListener('change', function () { setTradeResult(e.id, select.value); });
    tr.children[8].appendChild(select);
    const plTd = tr.children[9];
    if (pl !== null) { plTd.textContent = (pl >= 0 ? '+$' : '-$') + Math.abs(pl).toFixed(2); plTd.className = pl >= 0 ? 'pos-val' : 'neg-val'; }
    else plTd.textContent = '—';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn'; delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () { deleteTrade(e.id); });
    tr.children[10].appendChild(delBtn);
    tbody.appendChild(tr);
  });
  const summary = $('logSummary');
  if (!entries.length) { summary.textContent = 'No trades logged yet.'; }
  else {
    const winRate = settled > 0 ? (wins / settled * 100).toFixed(0) + '%' : '—';
    summary.innerHTML = entries.length + ' logged &middot; ' + settled + ' settled &middot; win rate ' + winRate +
      ' &middot; total P/L <span class="' + (totalPL >= 0 ? 'pos-val' : 'neg-val') + '">' +
      (totalPL >= 0 ? '+$' : '-$') + Math.abs(totalPL).toFixed(2) + '</span> &middot; stored locally in this browser only';
  }
}

/* ---------------------------- Matchup data & analysis (identical pattern to the other models) ---------------------------- */
const MATCHUP_DATA_KEY = 'kalshiCfbMatchupData';
const TRACKED_STATS = TSI_KEYS.map(function (k) {
  const key = k.charAt(0).toLowerCase() + k.slice(1);
  const lowerIsBetter = k === 'PointsAgainst' || k === 'DefEpaAllowed' || k === 'DefRushYards' || k === 'DefTotalYards' || k === 'DefPassYards';
  return { key: key, label: k.replace(/([A-Z])/g, ' $1').trim(), higherBetter: !lowerIsBetter };
}).concat([{ key: 'model', label: 'Model probability', higherBetter: true }, { key: 'market', label: 'Market probability', higherBetter: true }]);

function loadMatchupData() { try { return JSON.parse(localStorage.getItem(MATCHUP_DATA_KEY)) || []; } catch (e) { return []; } }
function saveMatchupData(entries) { localStorage.setItem(MATCHUP_DATA_KEY, JSON.stringify(entries)); }

function recordMatchup() {
  if (!lastCalc) { alert('Fetch both teams\' data first so there\'s a matchup to record.'); return; }
  const entries = loadMatchupData();
  const today = new Date().toISOString().slice(0, 10);
  const alreadyRecorded = entries.some(function (e) {
    return e.date === today && ((e.nameA === lastCalc.nameA && e.nameB === lastCalc.nameB) || (e.nameA === lastCalc.nameB && e.nameB === lastCalc.nameA));
  });
  if (alreadyRecorded && !confirm(lastCalc.nameA + ' vs ' + lastCalc.nameB + ' was already recorded today. Record it again anyway?')) return;
  const entry = { id: Date.now(), date: today, nameA: lastCalc.nameA, nameB: lastCalc.nameB, recSide: lastCalc.side, edgePts: lastCalc.edge * 100, modelA: lastCalc.modelA, modelB: lastCalc.modelB, marketA: lastCalc.marketA, marketB: lastCalc.marketB, result: 'pending' };
  TSI_KEYS.forEach(function (k) {
    const inputKey = k.charAt(0).toLowerCase() + k.slice(1);
    entry[inputKey + 'A'] = lastCalc[inputKey + 'A']; entry[inputKey + 'B'] = lastCalc[inputKey + 'B'];
  });
  entries.push(entry);
  saveMatchupData(entries);
  renderMatchupData();
}
function exportMatchupData() {
  const blob = new Blob([JSON.stringify(loadMatchupData(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'kalshi-cfb-matchup-data-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function importMatchupData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('not an array');
      const existing = loadMatchupData();
      const existingIds = new Set(existing.map(function (e) { return e.id; }));
      saveMatchupData(existing.concat(imported.filter(function (e) { return !existingIds.has(e.id); })));
      renderMatchupData();
      alert('Imported ' + imported.length + ' entries (merged; duplicates skipped).');
    } catch (err) { alert('Could not read that file as a matchup data export.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}
function setMatchupResult(id, result) {
  const entries = loadMatchupData();
  const e = entries.find(function (x) { return x.id === id; });
  if (e) e.result = result;
  saveMatchupData(entries); renderMatchupData();
}
function deleteMatchup(id) { saveMatchupData(loadMatchupData().filter(function (x) { return x.id !== id; })); renderMatchupData(); }

// Looks up the head-to-head game between two teams on a specific date via CFBD's /games (school
// names, not abbreviations, so no ESPN-style abbreviation lookup needed).
async function fetchMatchupResultCfbd(schoolA, schoolB, date) {
  const year = date.slice(0, 4);
  const games = await cfbdGet('/games?year=' + year + '&team=' + encodeURIComponent(schoolA));
  const game = games.find(function (g) {
    return g.completed && ((g.homeTeam === schoolA && g.awayTeam === schoolB) || (g.homeTeam === schoolB && g.awayTeam === schoolA)) &&
      (g.startDate || '').slice(0, 10) === date;
  });
  if (!game) return null;
  const homeWon = (game.homePoints || 0) > (game.awayPoints || 0);
  return homeWon ? game.homeTeam : game.awayTeam;
}
async function refreshMatchupResults() {
  const btn = $('refreshMatchupBtn');
  const status = $('refreshMatchupStatus');
  const entries = loadMatchupData();
  const pending = entries.filter(function (e) { return e.result === 'pending'; });
  if (!pending.length) { status.textContent = 'No pending matchups to check.'; return; }
  btn.disabled = true;
  let updated = 0, stillPending = 0, unresolved = 0;
  try {
    const teams = await getCfbTeams();
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      status.textContent = 'Checking ' + (i + 1) + ' of ' + pending.length + ' pending matchup(s) — ' + e.nameA + ' vs ' + e.nameB + '…';
      const teamA = findCfbTeam(e.nameA, teams), teamB = findCfbTeam(e.nameB, teams);
      if (!teamA || !teamB) { unresolved++; continue; }
      try {
        const winnerSchool = await fetchMatchupResultCfbd(teamA.school, teamB.school, e.date);
        if (winnerSchool === null) { stillPending++; continue; }
        e.result = (winnerSchool === teamA.school) ? 'A' : 'B';
        updated++;
      } catch (err) { stillPending++; }
    }
    saveMatchupData(entries);
    renderMatchupData();
    status.textContent = '✓ Checked ' + pending.length + ' pending matchup(s) — ' + updated + ' updated' +
      (stillPending ? ', ' + stillPending + ' still not final' : '') + (unresolved ? ', ' + unresolved + ' team name(s) not matched' : '') + '.';
  } catch (err) {
    status.textContent = 'Fetch failed: ' + err.message;
  } finally { btn.disabled = false; }
}

function fmtEdgePts(x) { return (x >= 0 ? '+' : '') + x.toFixed(1) + ' pts'; }
function computeRecommendationPerf(entries) {
  const settled = entries.filter(function (e) { return (e.result === 'A' || e.result === 'B') && e.recSide && e.edgePts !== undefined && e.edgePts !== null && !isNaN(e.edgePts); });
  const wins = [], losses = [];
  settled.forEach(function (e) { (e.recSide === e.result ? wins : losses).push(e.edgePts); });
  const avg = function (arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null; };
  return { total: settled.length, winCount: wins.length, lossCount: losses.length, winRate: settled.length ? (wins.length / settled.length) * 100 : null, avgEdgeWin: avg(wins), avgEdgeLoss: avg(losses) };
}
function renderRecommendationPerf() {
  const perf = computeRecommendationPerf(loadMatchupData());
  $('recWinRateVal').textContent = perf.winRate !== null ? perf.winRate.toFixed(1) + '%' : '—';
  $('recWinRateSub').textContent = perf.total + ' settled recommendation' + (perf.total === 1 ? '' : 's');
  $('avgEdgeWinVal').textContent = perf.avgEdgeWin !== null ? fmtEdgePts(perf.avgEdgeWin) : '—';
  $('avgEdgeWinSub').textContent = perf.winCount + ' win' + (perf.winCount === 1 ? '' : 's');
  $('avgEdgeLossVal').textContent = perf.avgEdgeLoss !== null ? fmtEdgePts(perf.avgEdgeLoss) : '—';
  $('avgEdgeLossSub').textContent = perf.lossCount + ' loss' + (perf.lossCount === 1 ? '' : 'es');
}
function computeStatAccuracy(entries) {
  const settled = entries.filter(function (e) { return e.result === 'A' || e.result === 'B'; }).slice().sort(function (a, b) { return a.id - b.id; });
  return TRACKED_STATS.map(function (stat) {
    let correct = 0, total = 0;
    settled.forEach(function (e) {
      const a = e[stat.key + 'A'], b = e[stat.key + 'B'];
      if (a === null || a === undefined || isNaN(a) || b === null || b === undefined || isNaN(b) || a === b) return;
      const prediction = (a > b) === stat.higherBetter ? 'A' : 'B';
      total++; if (prediction === e.result) correct++;
    });
    return { label: stat.label, correct: correct, total: total };
  });
}
function renderStatAccuracy() {
  const stats = computeStatAccuracy(loadMatchupData());
  const tbody = $('statAccuracyTbody');
  tbody.innerHTML = '';
  stats.forEach(function (s) {
    const acc = s.total > 0 ? ((s.correct / s.total) * 100).toFixed(1) + '%' : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + s.label + '</td><td>' + acc + '</td><td>' + s.total + '</td>';
    tbody.appendChild(tr);
  });
}
function renderMatchupData() {
  const entries = loadMatchupData();
  const tbody = $('matchupDataTbody');
  tbody.innerHTML = '';
  entries.slice().reverse().forEach(function (e) {
    const modelPick = e.modelA >= e.modelB ? e.nameA : e.nameB;
    const marketPick = e.marketA >= e.marketB ? e.nameA : e.nameB;
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + e.date + '</td><td>' + e.nameA + ' vs ' + e.nameB + '</td><td>' + modelPick + '</td><td>' + marketPick + '</td><td></td><td></td>';
    const select = document.createElement('select');
    [['pending', 'pending'], ['A', e.nameA + ' won'], ['B', e.nameB + ' won']].forEach(function (opt) {
      const o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1];
      if (opt[0] === e.result) o.selected = true; select.appendChild(o);
    });
    select.addEventListener('change', function () { setMatchupResult(e.id, select.value); });
    tr.children[4].appendChild(select);
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn'; delBtn.textContent = '✕';
    delBtn.addEventListener('click', function () { deleteMatchup(e.id); });
    tr.children[5].appendChild(delBtn);
    tbody.appendChild(tr);
  });
  const settledCount = entries.filter(function (e) { return e.result !== 'pending'; }).length;
  $('matchupDataSummary').textContent = entries.length === 0 ? 'No matchups recorded yet.' :
    entries.length + ' recorded · ' + settledCount + ' settled · stored locally in this browser only';
  renderRecommendationPerf();
  renderStatAccuracy();
}

/* ---------------------------- Clear All Data (hold-to-confirm, same pattern as the other models) ---------------------------- */
const HOLD_MS = 1400;
let holdRAF = null, holdStartTime = null;
function openClearDataModal() { $('clearDataModal').classList.remove('hidden'); }
function closeClearDataModal() { $('clearDataModal').classList.add('hidden'); cancelHold(); }
function cancelHold() {
  if (holdRAF !== null) { cancelAnimationFrame(holdRAF); holdRAF = null; }
  holdStartTime = null;
  const fill = $('holdFill'); if (fill) fill.style.width = '0%';
}
function startHold() {
  const fill = $('holdFill');
  holdStartTime = performance.now();
  function tick(now) {
    const pct = Math.min(100, ((now - holdStartTime) / HOLD_MS) * 100);
    fill.style.width = pct + '%';
    if (pct >= 100) { holdRAF = null; clearAllData(); return; }
    holdRAF = requestAnimationFrame(tick);
  }
  holdRAF = requestAnimationFrame(tick);
}
function clearAllData() {
  localStorage.removeItem(LOG_KEY);
  localStorage.removeItem(MATCHUP_DATA_KEY);
  renderLog(); renderMatchupData();
  closeClearDataModal();
}
(function () {
  const btn = $('holdDeleteBtn');
  btn.addEventListener('pointerdown', function (e) { e.preventDefault(); startHold(); });
  btn.addEventListener('pointerup', cancelHold);
  btn.addEventListener('pointerleave', cancelHold);
  btn.addEventListener('pointercancel', cancelHold);
  window.addEventListener('blur', cancelHold);
})();

/* ---------------------------- init ---------------------------- */
document.getElementById('teamAName').addEventListener('blur', function () { resolveAndBadge('A'); });
document.getElementById('teamBName').addEventListener('blur', function () { resolveAndBadge('B'); });
getCfbTeams().catch(function () {});
resolveAndBadge('A'); resolveAndBadge('B');
recalc();
renderLog();
renderMatchupData();
