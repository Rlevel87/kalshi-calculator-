/* =======================================================================
   Kalshi NFL Value Model.
   Team composite: nflverse's per-team-week stats (real EPA, yards, points,
   turnovers), proxied+aggregated server-side since neither ESPN nor
   nflverse's actual data files support CORS for direct browser calls.
   Player ratings, depth charts, injuries: ESPN's hidden API, same proxy.
   Everything else (market inputs, trade log, matchup data/accuracy
   tracking) mirrors the baseball model's proven pattern.
   ======================================================================= */

// NFL seasons are named for the year they kick off in (games in Jan/Feb belong to the
// PRIOR year's season label), so roll over Jan/Feb to the previous year here too -- same
// rule server.py uses for the team composite. Player ratings try CURRENT_SEASON first and
// fall back to FALLBACK_SEASON per player, so this needs no manual update once 2026 games
// start rolling in -- it switches over on its own.
const NFL_SEASON_YEAR = (function () {
  const now = new Date();
  const m = now.getUTCMonth() + 1; // 1-12
  return m >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
})();
const CURRENT_SEASON = String(NFL_SEASON_YEAR);
const FALLBACK_SEASON = String(NFL_SEASON_YEAR - 1);

let lastCalc = null;
let nflTeamsCache = null;
let lastFetchedSeason = { A: null, B: null }; // which season each side's team stats actually came from

function $(id) { return document.getElementById(id); }
function val(id) { return parseFloat($(id).value); }
function txt(id) { return $(id).value.trim(); }

/* ---------------------------- math helpers (same formulas as the baseball model) ---------------------------- */
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

/* ---------------------------- weights: auto-normalize a set of "w<Key>" sliders to sum to 1 ---------------------------- */
function weights(prefix, keys) {
  const w = {};
  let sum = 0;
  keys.forEach(k => { w[k] = val(prefix + k) || 0; sum += w[k]; });
  if (sum > 0) keys.forEach(k => { w[k] /= sum; });
  return w;
}

/* ---------------------------- server proxy fetch helpers ---------------------------- */
// Shared by every proxy call. If server.py isn't actually running behind this page (opened as
// a bare file, or through some other static-file previewer with no /api routes), the fetch
// often still "succeeds" -- it just gets an HTML page back instead of JSON, and .json() on that
// throws a cryptic "Unexpected token '<'..." error. Checking content-type first turns that into
// a plain, actionable message instead.
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
async function espnGet(path) { return fetchJson('/api/espn/site' + path); }
async function espnWebGet(path) { return fetchJson('/api/espn/web' + path); }
async function teamSummaryGet(team, season) {
  // No season given -> let the server pick (tries current NFL season, falls back to the
  // prior completed one automatically). Passing one explicitly overrides that.
  const qs = season ? ('?season=' + encodeURIComponent(season)) : '';
  return fetchJson('/api/nfl/team-summary/' + encodeURIComponent(team) + qs);
}

/* ---------------------------- team resolution ---------------------------- */
async function getNflTeams() {
  if (nflTeamsCache) return nflTeamsCache;
  const data = await espnGet('/teams?limit=32');
  nflTeamsCache = data.sports[0].leagues[0].teams.map(t => t.team);
  return nflTeamsCache;
}
function findTeam(query, teams) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = teams.find(t =>
    t.abbreviation.toLowerCase() === q || t.displayName.toLowerCase() === q ||
    t.name.toLowerCase() === q || (t.shortDisplayName || '').toLowerCase() === q);
  if (exact) return exact;
  return teams.find(t =>
    t.displayName.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) ||
    (t.location || '').toLowerCase().includes(q)) || null;
}
function applyTeamBadge(side, team) {
  $('mbName' + side).textContent = team.displayName;
  const logo = $('mbLogo' + side);
  logo.classList.remove('loaded');
  logo.onload = function () { logo.classList.add('loaded'); };
  logo.onerror = function () { logo.classList.remove('loaded'); };
  logo.src = team.logos && team.logos[0] ? team.logos[0].href : '';
  logo.alt = team.displayName + ' logo';
}
async function resolveAndBadge(side) {
  const name = txt(side === 'A' ? 'teamAName' : 'teamBName');
  if (!name) return;
  try {
    const teams = await getNflTeams();
    const team = findTeam(name, teams);
    if (team) applyTeamBadge(side, team);
  } catch (e) { /* cosmetic only */ }
}

/* ---------------------------- injuries (league-wide, one call) ---------------------------- */
// The injury report's athlete object has no bare id field -- extract it from the player-card link.
function extractAthleteId(athlete) {
  if (!athlete || !athlete.links) return null;
  for (const l of athlete.links) {
    const m = /\/id\/(\d+)\//.exec(l.href || '');
    if (m) return m[1];
  }
  return null;
}
const INACTIVE_STATUSES = ['out', 'injured reserve', 'ir', 'suspended', 'pup', 'physically unable to perform', 'reserve/pup'];

async function getInjuriesByAthleteId() {
  const data = await espnGet('/injuries');
  const map = {};
  (data.injuries || []).forEach(function (teamGroup) {
    (teamGroup.injuries || []).forEach(function (inj) {
      const id = extractAthleteId(inj.athlete);
      if (!id) return;
      const statusText = inj.status || (inj.type && inj.type.description) || 'Unknown';
      map[id] = {
        status: statusText,
        detail: inj.details && inj.details.type,
        inactive: INACTIVE_STATUSES.indexOf(statusText.toLowerCase()) !== -1
      };
    });
  });
  return map;
}

/* ---------------------------- depth chart ---------------------------- */
async function getDepthChart(teamAbbrev) {
  const data = await espnGet('/teams/' + teamAbbrev.toLowerCase() + '/depthcharts');
  const groups = data.depthchart || [];
  const offenseGroup = groups.find(function (g) { return g.positions && g.positions.qb; });
  const defenseGroup = groups.find(function (g) {
    return g !== offenseGroup && g.name !== 'Special Teams' && g.positions && Object.keys(g.positions).length > 0;
  });
  return { offenseGroup: offenseGroup || null, defenseGroup: defenseGroup || null };
}
// One call returns every season ESPN has on file for this player, across every stat category
// (passing/rushing/receiving/defensive/kicking/punting -- whichever apply). Fetched once when
// the stats modal opens; switching the year dropdown just re-slices this same cached result,
// no extra network round-trip per year.
async function getPlayerCategories(athleteId) {
  const data = await espnWebGet('/athletes/' + athleteId + '/stats');
  return data.categories || [];
}
function escapeAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

function buildSlotList(group) {
  if (!group) return [];
  return Object.keys(group.positions).map(function (key) {
    const posData = group.positions[key];
    return {
      key: key,
      abbrev: (posData.position && posData.position.abbreviation) || key.toUpperCase(),
      athletes: posData.athletes || []
    };
  });
}
/* ---------------------------- depth chart + injuries rendering ---------------------------- */
const OFFENSE_ORDER = ['qb', 'rb', 'wr1', 'wr2', 'wr3', 'te', 'lt', 'lg', 'c', 'rg', 'rt'];
const DEFENSE_HINT_ORDER = ['lde', 'ldt', 'ndt', 'rdt', 'rde', 'wlb', 'mlb', 'slb', 'lolb', 'rolb', 'ilb', 'lcb', 'rcb', 'nb', 'ss', 'fs'];
function sortSlots(slots, hintOrder) {
  return slots.slice().sort(function (a, b) {
    const ia = hintOrder.indexOf(a.key), ib = hintOrder.indexOf(b.key);
    if (ia === -1 && ib === -1) return a.key.localeCompare(b.key);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}
/* ---------------------------- main fetch orchestration ---------------------------- */
async function fetchMatchup() {
  const btn = $('fetchBtn');
  const status = $('fetchStatus');
  const nameA = txt('teamAName'), nameB = txt('teamBName');
  if (!nameA || !nameB) { status.textContent = 'Enter both team names first.'; return; }

  btn.disabled = true;
  try {
    status.textContent = 'Looking up teams…';
    const teams = await getNflTeams();
    const teamA = findTeam(nameA, teams), teamB = findTeam(nameB, teams);
    if (!teamA || !teamB) {
      status.textContent = 'Could not match one or both team names.';
      return;
    }
    $('teamAName').value = teamA.displayName;
    $('teamBName').value = teamB.displayName;
    applyTeamBadge('A', teamA);
    applyTeamBadge('B', teamB);

    status.textContent = 'Fetching team season stats…';
    const [summaryA, summaryB] = await Promise.all([
      teamSummaryGet(teamA.abbreviation).catch(function () { return null; }),
      teamSummaryGet(teamB.abbreviation).catch(function () { return null; })
    ]);
    applyTeamSummaryToInputs('A', summaryA);
    applyTeamSummaryToInputs('B', summaryB);

    status.textContent = 'Fetching depth charts and injuries…';
    const [dcA, dcB, injuryMap] = await Promise.all([
      getDepthChart(teamA.abbreviation),
      getDepthChart(teamB.abbreviation),
      getInjuriesByAthleteId()
    ]);
    const offSlotsA = buildSlotList(dcA.offenseGroup), defSlotsA = buildSlotList(dcA.defenseGroup);
    const offSlotsB = buildSlotList(dcB.offenseGroup), defSlotsB = buildSlotList(dcB.defenseGroup);
    renderDepthChartGrid(teamA.displayName, offSlotsA, defSlotsA, teamB.displayName, offSlotsB, defSlotsB, injuryMap);
    $('depthChartStatus').textContent = '✓ Depth charts and injury report loaded for both teams.';

    recalc();
    const seasonNote = lastFetchedSeason.A === CURRENT_SEASON || lastFetchedSeason.B === CURRENT_SEASON
      ? ' Team stats: ' + (lastFetchedSeason.A || '?') + '/' + (lastFetchedSeason.B || '?') + ' (switches to ' + CURRENT_SEASON + ' automatically once it has games). Player ratings use ' + CURRENT_SEASON + ' where a player has it, else ' + FALLBACK_SEASON + '.'
      : ' Team stats: ' + FALLBACK_SEASON + ' season (most recent completed — ' + CURRENT_SEASON + ' has no games yet). Player ratings: same, per player.';
    status.textContent = '✓ Loaded ' + teamA.displayName + ' vs ' + teamB.displayName + '.' + seasonNote;
  } catch (err) {
    status.textContent = 'Fetch failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function renderDepthChartGrid(nameA, offA, defA, nameB, offB, defB, injuryMap) {
  const el = $('depthChartGrid');
  function rowsHtml(slots, hintOrder) {
    return sortSlots(slots, hintOrder).map(function (slot) {
      const names = slot.athletes.slice(0, 3).map(function (a, i) {
        const inj = injuryMap[a.id];
        const cls = i === 0 ? (inj && inj.inactive ? 'inactive' : 'starter') : 'backup';
        const tag = inj ? '<span class="injury-tag" title="' + (inj.detail || '') + '">' + inj.status + '</span>' : '';
        return '<span class="depth-player clickable ' + cls + '" data-athlete-id="' + a.id +
          '" data-athlete-name="' + escapeAttr(a.displayName) + '" data-pos="' + escapeAttr(slot.abbrev) +
          '" title="Click to see season stats">' + a.displayName + tag + '</span>';
      }).join(' &middot; ');
      return '<div class="depth-pos-row"><span class="depth-pos-label">' + slot.abbrev + '</span>' + (names || '<span class="empty-note">—</span>') + '</div>';
    }).join('');
  }
  function teamBlock(name, off, def) {
    return '<div><h3 style="margin:0 0 8px; font-size:13px; color:var(--ink-muted);">' + name + ' &mdash; Offense</h3>' + rowsHtml(off, OFFENSE_ORDER) +
      '<h3 style="margin:14px 0 8px; font-size:13px; color:var(--ink-muted);">' + name + ' &mdash; Defense</h3>' + rowsHtml(def, DEFENSE_HINT_ORDER) + '</div>';
  }
  el.innerHTML = teamBlock(nameA, offA, defA) + teamBlock(nameB, offB, defB);
}

/* ---------------------------- player stats modal (click a depth chart name) ---------------------------- */
let playerStatsCategories = null; // cached ESPN categories for whichever athlete is currently open

function statsYearOptions() {
  const years = [];
  for (let i = 0; i < 6; i++) years.push(String(NFL_SEASON_YEAR - i));
  return years;
}
function humanizeStatName(name) {
  // camelCase -> "Spaced Words", e.g. "passingYards" -> "Passing Yards"
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); });
}
async function openPlayerStatsModal(athleteId, playerName, posAbbrev) {
  $('playerStatsModal').classList.remove('hidden');
  $('playerStatsName').textContent = playerName;
  $('playerStatsPos').textContent = posAbbrev || '';
  $('playerStatsBody').innerHTML = '<div class="fetch-status">Loading stats…</div>';

  const yearSelect = $('playerStatsYear');
  yearSelect.innerHTML = '';
  statsYearOptions().forEach(function (y) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    yearSelect.appendChild(opt);
  });
  yearSelect.value = CURRENT_SEASON; // preset to the present year, per the ask

  playerStatsCategories = null;
  try {
    playerStatsCategories = await getPlayerCategories(athleteId);
    renderPlayerStatsForYear(yearSelect.value);
  } catch (err) {
    $('playerStatsBody').innerHTML = '<div class="fetch-status">Could not load stats: ' + err.message + '</div>';
  }
}
function closePlayerStatsModal() {
  $('playerStatsModal').classList.add('hidden');
  playerStatsCategories = null;
}
function loadPlayerStatsForYear() {
  if (!playerStatsCategories) return;
  renderPlayerStatsForYear($('playerStatsYear').value);
}
function renderPlayerStatsForYear(year) {
  const body = $('playerStatsBody');
  if (!playerStatsCategories) { body.innerHTML = '<div class="fetch-status">No data.</div>'; return; }
  let html = '';
  playerStatsCategories.forEach(function (cat) {
    if (!cat.statistics || !cat.names) return;
    const entry = cat.statistics.find(function (s) { return s.season && String(s.season.year) === String(year); });
    if (!entry) return;
    const rows = cat.names.map(function (name, i) {
      const raw = entry.stats[i];
      if (raw === undefined || raw === null || raw === '-' || raw === '') return '';
      return '<tr><td>' + humanizeStatName(name) + '</td><td>' + raw + '</td></tr>';
    }).join('');
    if (!rows) return;
    const label = cat.displayName || humanizeStatName(cat.name || 'Stats');
    html += '<div class="player-stat-cat"><h4>' + label + '</h4><table class="player-stat-table"><tbody>' + rows + '</tbody></table></div>';
  });
  body.innerHTML = html || '<div class="fetch-status">No stats found for ' + year + '.</div>';
}
// One delegated listener covers every player name, present and future re-renders alike --
// no need to re-attach after each fetchMatchup() rebuilds the depth chart grid.
document.getElementById('depthChartGrid').addEventListener('click', function (e) {
  const el = e.target.closest('.depth-player');
  if (!el || !el.dataset.athleteId) return;
  openPlayerStatsModal(el.dataset.athleteId, el.dataset.athleteName, el.dataset.pos);
});

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

/* ---------------------------- Trade log (identical pattern to the baseball model) ---------------------------- */
const LOG_KEY = 'kalshiNflTradeLog';
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
  a.href = url; a.download = 'kalshi-nfl-trade-log-' + new Date().toISOString().slice(0, 10) + '.json';
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

/* ---------------------------- Matchup data & analysis (identical pattern to baseball) ---------------------------- */
const MATCHUP_DATA_KEY = 'kalshiNflMatchupData';
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
  a.href = url; a.download = 'kalshi-nfl-matchup-data-' + new Date().toISOString().slice(0, 10) + '.json';
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

// Looks up the head-to-head game between two teams on a specific date via ESPN's scoreboard,
// and returns the winning team's abbreviation once it's final, or null if not finished yet.
async function fetchMatchupResultEspn(teamAAbbr, teamBAbbr, date) {
  const yyyymmdd = date.replace(/-/g, '');
  const data = await espnGet('/scoreboard?dates=' + yyyymmdd);
  for (const event of (data.events || [])) {
    const comp = event.competitions && event.competitions[0];
    if (!comp) continue;
    const competitors = comp.competitors || [];
    const abbrs = competitors.map(function (c) { return c.team.abbreviation; });
    if (abbrs.indexOf(teamAAbbr) === -1 || abbrs.indexOf(teamBAbbr) === -1) continue;
    if (!comp.status || comp.status.type.name !== 'STATUS_FINAL') return null;
    const winner = competitors.find(function (c) { return c.winner; });
    return winner ? winner.team.abbreviation : null;
  }
  return null;
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
    const teams = await getNflTeams();
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      status.textContent = 'Checking ' + (i + 1) + ' of ' + pending.length + ' pending matchup(s) — ' + e.nameA + ' vs ' + e.nameB + '…';
      const teamA = findTeam(e.nameA, teams), teamB = findTeam(e.nameB, teams);
      if (!teamA || !teamB) { unresolved++; continue; }
      try {
        const winnerAbbr = await fetchMatchupResultEspn(teamA.abbreviation, teamB.abbreviation, e.date);
        if (winnerAbbr === null) { stillPending++; continue; }
        e.result = (winnerAbbr === teamA.abbreviation) ? 'A' : 'B';
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

/* ---------------------------- Clear All Data (hold-to-confirm, same pattern as baseball) ---------------------------- */
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
getNflTeams().catch(function () {});
resolveAndBadge('A'); resolveAndBadge('B');
recalc();
renderLog();
renderMatchupData();
