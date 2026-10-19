/* =======================================================================
   Kalshi NBA Value Model.
   Three signals -- the only ones that improved held-out predictions once ESPN's 114 box-score
   stats over 2021-22..2025-26 were folded together (nba_signal_selection.py): point
   differential (this season blended with last), missing rotation minutes tonight (from the
   depth chart + injury report), back-to-back -- plus a fitted home-court edge.
   Trade log / matchup data / accuracy tracking mirror the hockey and football models.
   ======================================================================= */

let lastCalc = null;
let nbaTeamsCache = null;
function $(id) { return document.getElementById(id); }
function val(id) { return parseFloat($(id).value); }
function txt(id) { return $(id).value.trim(); }

/* ---------------------------- math helpers (same formulas as the other models) ---------------------------- */
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
function fmtNum(x, d) { return (x === null || x === undefined || isNaN(x)) ? '—' : Number(x).toFixed(d === undefined ? 1 : d); }

function weights(prefix, keys) {
  const w = {};
  let sum = 0;
  keys.forEach(k => { w[k] = val(prefix + k) || 0; sum += w[k]; });
  if (sum > 0) keys.forEach(k => { w[k] /= sum; });
  return w;
}

/* ---------------------------- dates ---------------------------- */
function localIsoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function yyyymmdd(isoDate) { return isoDate.replace(/-/g, ''); }
function shiftIsoDate(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
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
async function espnGet(path) { return fetchJson('/api/espn/nba-site' + path); }

/* ---------------------------- team resolution ---------------------------- */
async function getNbaTeams() {
  if (nbaTeamsCache) return nbaTeamsCache;
  const data = await espnGet('/teams?limit=40');
  nbaTeamsCache = data.sports[0].leagues[0].teams.map(t => t.team);
  return nbaTeamsCache;
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
function teamLogoUrl(team) {
  const logos = team.logos || [];
  const dark = logos.find(function (l) { return l.rel && l.rel.indexOf('dark') !== -1; });
  return (dark || logos[0] || {}).href || '';
}
function applyTeamBadge(side, team) {
  $('mbName' + side).textContent = team.displayName;
  const logo = $('mbLogo' + side);
  logo.classList.remove('loaded');
  logo.onload = function () { logo.classList.add('loaded'); };
  logo.onerror = function () { logo.classList.remove('loaded'); };
  logo.src = teamLogoUrl(team);
  logo.alt = team.displayName + ' logo';

  document.documentElement.style.setProperty('--team-' + side.toLowerCase() + '-color', '#' + (team.color || (side === 'A' ? '4fb0c6' : 'c9a24b')));
  const bgLogo = $('teamBgLogo' + side);
  if (bgLogo) {
    bgLogo.classList.remove('loaded');
    bgLogo.onload = function () { bgLogo.classList.add('loaded'); };
    bgLogo.onerror = function () { bgLogo.classList.remove('loaded'); };
    bgLogo.src = teamLogoUrl(team);
  }
}
async function resolveAndBadge(side) {
  const name = txt(side === 'A' ? 'teamAName' : 'teamBName');
  if (!name) return;
  try {
    const team = findTeam(name, await getNbaTeams());
    if (team) applyTeamBadge(side, team);
  } catch (e) { /* cosmetic only */ }
}

/* ---------------------------- game context: home court + back-to-backs from ESPN's schedule ---------------------------- */
const scoreboardCache = {}; // yyyymmdd -> Promise<events[]>
function getScoreboardEvents(isoDate) {
  const key = yyyymmdd(isoDate);
  if (!scoreboardCache[key]) {
    scoreboardCache[key] = espnGet('/scoreboard?dates=' + key).then(function (d) { return d.events || []; })
      .catch(function (err) { delete scoreboardCache[key]; throw err; });
  }
  return scoreboardCache[key];
}
function findGame(events, displayNames) {
  for (const e of events) {
    const comp = e.competitions && e.competitions[0];
    if (!comp || !comp.competitors) continue;
    const names = comp.competitors.map(function (c) { return c.team.displayName; });
    if (displayNames.every(function (n) { return names.indexOf(n) !== -1; })) return comp;
  }
  return null;
}
function playedOn(events, displayName) {
  return events.some(function (e) {
    const comp = e.competitions && e.competitions[0];
    return comp && (comp.competitors || []).some(function (c) { return c.team.displayName === displayName; });
  });
}
// Returns a short note for the status line. Leaves the inputs untouched if the game isn't on
// the schedule for that date, so manual settings survive a wrong/missing date.
async function applyGameContext(teamA, teamB) {
  const date = $('gameDate').value;
  if (!date) return 'no game date set — home/back-to-back left as entered';
  const [today, yesterday] = await Promise.all([getScoreboardEvents(date), getScoreboardEvents(shiftIsoDate(date, -1))]);
  const game = findGame(today, [teamA.displayName, teamB.displayName]);
  $('b2bA').checked = playedOn(yesterday, teamA.displayName);
  $('b2bB').checked = playedOn(yesterday, teamB.displayName);
  if (!game) return 'no ' + teamA.shortDisplayName + '–' + teamB.shortDisplayName + ' game found on ' + date + ' — check home court';
  const home = game.competitors.find(function (c) { return c.homeAway === 'home'; });
  if (game.neutralSite) $('homeSide').value = '';
  else if (home) $('homeSide').value = home.team.displayName === teamA.displayName ? 'A' : 'B';
  return 'game found on ' + date;
}

function lowerFirst(k) { return k.charAt(0).toLowerCase() + k.slice(1); }

async function teamSummaryGet(abbrev) { return fetchJson('/api/nba/team-summary/' + encodeURIComponent(abbrev)); }

/* ---------------------------- main fetch orchestration ---------------------------- */
async function fetchMatchup() {
  const btn = $('fetchBtn');
  const status = $('fetchStatus');
  const nameA = txt('teamAName'), nameB = txt('teamBName');
  if (!nameA || !nameB) { status.textContent = 'Enter both team names first.'; return; }

  btn.disabled = true;
  try {
    status.textContent = 'Looking up teams…';
    const teams = await getNbaTeams();
    const teamA = findTeam(nameA, teams), teamB = findTeam(nameB, teams);
    if (!teamA || !teamB) { status.textContent = 'Could not match one or both team names.'; return; }
    $('teamAName').value = teamA.displayName;
    $('teamBName').value = teamB.displayName;
    applyTeamBadge('A', teamA);
    applyTeamBadge('B', teamB);

    $('recordStatus').textContent = '';
    lineups = { A: null, B: null };
    ['A', 'B'].forEach(function (sd) { $('missingNote' + sd).textContent = 'Loading depth chart…'; });
    loadLineups(teamA, teamB); // separate from the stats so a slow depth chart never holds up the model

    status.textContent = 'Fetching team results and schedule…';
    const [summaryA, summaryB, contextNote] = await Promise.all([
      teamSummaryGet(teamA.abbreviation).catch(function () { return null; }),
      teamSummaryGet(teamB.abbreviation).catch(function () { return null; }),
      applyGameContext(teamA, teamB).catch(function (err) { return 'schedule lookup failed (' + err.message + ') — check home/back-to-back'; })
    ]);
    applyTeamSummaryToInputs('A', summaryA);
    applyTeamSummaryToInputs('B', summaryB);
    recalc();

    const missing = [!summaryA && teamA.displayName, !summaryB && teamB.displayName].filter(Boolean);
    status.textContent = (missing.length ? '⚠ No results for ' + missing.join(' & ') + '. ' : '✓ ') +
      'Loaded ' + teamA.displayName + ' vs ' + teamB.displayName + '.' + blendNote(summaryA, summaryB) +
      ' Context: ' + contextNote + '.';
  } catch (err) {
    status.textContent = 'Fetch failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// Early in a season the server blends in last season as 10 games' worth (backtested) -- say how much.
function blendNote(a, b) {
  const parts = [a, b].filter(Boolean).map(function (x) {
    return x.team + ' ' + Math.round(x.priorSeasonWeight * 100) + '% last season';
  });
  return parts.length ? ' Point diff blends this season with last (' + parts.join(', ') + ' — fades as games are played).' : '';
}

function applyTeamSummaryToInputs(side, s) {
  if (!s) return;
  $('pointDiff' + side).value = fmtNum(s.pointDiffPerGame, 2);
  const c = s.current, p = s.previous;
  $('record' + side).textContent = (c.gamesPlayed ? c.wins + '–' + (c.gamesPlayed - c.wins) + ' this season' : 'no games yet this season') +
    (p.gamesPlayed ? ' · ' + p.wins + '–' + (p.gamesPlayed - p.wins) + ' last season' : '');
}

/* ---------------------------- depth chart + injuries ---------------------------- */
// Starters are ESPN's depth chart, except an injured starter keeps his slot (struck through)
// rather than his fill-in being shown as the starter -- see _compute_nba_lineup in server.py.
// Missing rotation minutes = minutes/game of rotation players who are OUT -- exactly how the
// backtest measured it. Click any player to mark him in or out (e.g. a questionable player who's
// been ruled out at shootaround); the model updates immediately.
const DTD_STATUSES = ['day-to-day', 'questionable', 'probable'];
const POS_LABELS = { pg: 'PG', sg: 'SG', sf: 'SF', pf: 'PF', c: 'C' };
let lineups = { A: null, B: null };
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function allPlayers(lu) { return Object.values(lu.starters).concat(lu.bench); }
function isOut(p) { return p.outOverride !== undefined ? p.outOverride : p.inactive; }

function playerHtml(side, p, slot, extraClass) {
  if (!p) return slot ? '<span class="depth-slot">' + slot + '</span><span class="depth-player backup">—</span>' : '';
  const cls = isOut(p) ? 'inactive' : (extraClass || '');
  const tagCls = p.injury && DTD_STATUSES.indexOf(p.injury.toLowerCase()) !== -1 ? 'injury-tag dtd' : 'injury-tag';
  const tag = p.injury ? '<span class="' + tagCls + '" title="' + escapeHtml(p.injuryDetail || '') + '">' + escapeHtml(p.injury) + '</span>' : '';
  const manual = p.outOverride !== undefined && p.outOverride !== p.inactive ? '<span class="injury-tag dtd">' + (p.outOverride ? 'marked out' : 'marked in') + '</span>' : '';
  const stat = p.mpg ? p.mpg.toFixed(1) + ' min' + (p.statSeason === 'previous' ? '*' : '') : '';
  return (slot ? '<span class="depth-slot">' + slot + '</span>' : '') +
    '<span class="depth-player clickable ' + cls + '" data-side="' + side + '" data-id="' + escapeHtml(p.id) +
    '" title="Click to mark ' + (isOut(p) ? 'in' : 'out') + ' for tonight">' + escapeHtml(p.name) + '</span>' +
    (stat ? '<span class="depth-toi">' + stat + '</span>' : '') + tag + manual;
}
function lineupBlockHtml(side, name) {
  const lu = lineups[side];
  if (!lu || lu.error) return '<div><h3>' + escapeHtml(name) + '</h3><div class="fetch-status">Depth chart unavailable' + (lu && lu.error ? ': ' + escapeHtml(lu.error) : '') + '.</div></div>';
  const row = function (label, inner) { return '<div class="depth-pos-row"><span class="depth-pos-label">' + label + '</span>' + inner + '</div>'; };
  let html = '<div><h3>' + escapeHtml(name) + ' &mdash; Starters</h3>';
  Object.keys(POS_LABELS).forEach(function (pos) { html += row(POS_LABELS[pos], playerHtml(side, lu.starters[pos])); });
  html += '<h3>Bench</h3>';
  const rot = lu.bench.filter(function (p) { return p.rotation; }), rest = lu.bench.filter(function (p) { return !p.rotation; });
  if (rot.length) html += row('Rot', rot.map(function (p) { return playerHtml(side, p, null, 'backup'); }).join(' &middot; '));
  if (rest.length) html += row('Rest', rest.map(function (p) { return playerHtml(side, p, null, 'backup'); }).join(' &middot; '));
  return html + '</div>';
}
function renderLineups() {
  $('depthChartGrid').innerHTML = lineupBlockHtml('A', txt('teamAName')) + lineupBlockHtml('B', txt('teamBName'));
  ['A', 'B'].forEach(function (side) {
    const lu = lineups[side];
    if (!lu || lu.error) { $('missingNote' + side).textContent = ''; return; }
    const out = allPlayers(lu).filter(function (p) { return isOut(p) && p.rotation; });
    $('missingMin' + side).value = out.reduce(function (t, p) { return t + p.mpg; }, 0).toFixed(1);
    $('missingNote' + side).textContent = out.length
      ? 'Out: ' + out.map(function (p) { return p.name + ' (' + p.mpg.toFixed(1) + ')'; }).join(', ')
      : 'No rotation players out.';
  });
}
async function loadLineups(teamA, teamB) {
  const status = $('depthChartStatus');
  status.textContent = 'Loading depth charts and injuries…';
  $('depthChartGrid').innerHTML = '';
  const get = function (t) {
    return fetchJson('/api/nba/lineup/' + encodeURIComponent(t.abbreviation)).catch(function (err) { return { error: err.message }; });
  };
  const [luA, luB] = await Promise.all([get(teamA), get(teamB)]);
  if (txt('teamAName') !== teamA.displayName || txt('teamBName') !== teamB.displayName) return; // a newer fetch started
  lineups = { A: luA, B: luB };
  renderLineups();
  recalc();
  const rule = (luA && luA.rotationRule) || (luB && luB.rotationRule) || '';
  status.textContent = (luA.error || luB.error ? '⚠ ' : '✓ ') + 'Struck through = out tonight (counted in missing rotation minutes); yellow tag = ' +
    'day-to-day / questionable, still counted as playing. Click a player to mark him in or out. ' + rule + ' (* = last season\'s minutes).';
}
document.getElementById('depthChartGrid').addEventListener('click', function (e) {
  const el = e.target.closest('.depth-player.clickable');
  if (!el) return;
  const lu = lineups[el.dataset.side];
  const p = lu && allPlayers(lu).find(function (x) { return String(x.id) === el.dataset.id; });
  if (!p) return;
  p.outOverride = !isOut(p);
  renderLineups();
  recalc();
});

/* ---------------------------- composite + recalc ---------------------------- */
// TSI = w_pd * z(point diff) - w_mm * z(missing rotation minutes) - w_b2b * [back-to-back] +/- home edge / 2.
// P(A wins) = 1 / (1 + 10^(-(TSI_A - TSI_B) / scale)) -- identical to log5 of the two logistics.
const TSI_KEYS = ['PointDiff', 'MissingMin', 'B2b'];
const STAT_KEYS = ['PointDiff', 'MissingMin'];

function compositeTSI(side, w) {
  const homeSide = $('homeSide').value, edge = val('homeEdge') / 2;
  const c = {
    PointDiff: w.PointDiff * z(val('pointDiff' + side), val('pointDiffMean'), val('pointDiffSd')),
    MissingMin: -w.MissingMin * z(val('missingMin' + side), val('missingMinMean'), val('missingMinSd')),
    B2b: $('b2b' + side).checked ? -w.B2b : 0,
    Home: homeSide === side ? edge : (homeSide ? -edge : 0)
  };
  let total = 0;
  Object.keys(c).forEach(function (k) { total += c[k]; });
  return { total: total, contributions: c };
}

function paintContribBadge(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value === null || value === undefined || isNaN(value)) { el.textContent = ''; el.className = 'stat-contrib'; return; }
  const pts = value * 100;
  el.textContent = (pts >= 0 ? '+' : '') + pts.toFixed(2);
  el.className = 'stat-contrib ' + (pts >= 0 ? 'pl-pos' : 'pl-neg');
}
function renderContribBadges(side, c) {
  ['PointDiff', 'MissingMin', 'B2b', 'Home'].forEach(function (k) { paintContribBadge('contrib' + k + side, c[k]); });
}

function recalc() {
  const nameA = txt('teamAName') || 'Team A', nameB = txt('teamBName') || 'Team B';
  $('cardATitle').textContent = nameA + ' — Season Stats';
  $('cardBTitle').textContent = nameB + ' — Season Stats';
  $('resATitle').textContent = nameA;
  $('resBTitle').textContent = nameB;
  $('logSideOptA').textContent = nameA; $('logSideOptB').textContent = nameB;
  $('spreadOptA').textContent = nameA; $('spreadOptB').textContent = nameB;
  $('homeOptA').textContent = nameA + ' home'; $('homeOptB').textContent = nameB + ' home';
  $('b2bALabel').textContent = nameA + ' on back-to-back';
  $('b2bBLabel').textContent = nameB + ' on back-to-back';

  const w = weights('w', TSI_KEYS);
  const resultA = compositeTSI('A', w), resultB = compositeTSI('B', w);
  const modelA = 1 / (1 + Math.pow(10, -(resultA.total - resultB.total) / val('scale'))), modelB = 1 - modelA;
  renderContribBadges('A', resultA.contributions);
  renderContribBadges('B', resultB.contributions);
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

  let side, edge, price, model, name;
  if (edgeA >= edgeB) { side = 'A'; edge = edgeA; price = rawA; model = modelA; name = nameA; }
  else { side = 'B'; edge = edgeB; price = rawB; model = modelB; name = nameB; }

  $('edgeVal').textContent = fmtPts(edge);
  const ev = model - price;
  $('evVal').textContent = (ev >= 0 ? '+$' : '-$') + Math.abs(ev).toFixed(3);
  $('evSub').textContent = 'per $1 staked on ' + name;

  let stakeFrac = 0;
  if (edge >= threshold) {
    banner.className = 'rec-banner pos';
    recMain.textContent = 'Buy ' + name + ' Yes';
    stakeFrac = kellyFraction(model, price) * kellyFrac;
    $('kellyVal').textContent = (stakeFrac * 100).toFixed(1) + '%';
    $('kellySub').textContent = '≈ $' + (stakeFrac * bankroll).toFixed(2) + ' of bankroll (fractional Kelly)';
  } else if (edge <= -threshold) {
    banner.className = 'rec-banner neg';
    recMain.textContent = 'No trade — market looks ahead of the model';
    $('kellyVal').textContent = '$0.00'; $('kellySub').textContent = 'no positive-EV side found above threshold';
  } else {
    banner.className = 'rec-banner';
    recMain.textContent = 'Pass — edge below threshold';
    $('kellyVal').textContent = '$0.00'; $('kellySub').textContent = 'edge too small to act on';
  }
  recEdgeVal.textContent = fmtPts(edge);

  lastCalc = {
    nameA: nameA, nameB: nameB, side: side, edge: edge, price: price, model: model, stakeFrac: stakeFrac, bankroll: bankroll,
    modelA: modelA, modelB: modelB, marketA: marketA, marketB: marketB, rawA: rawA, rawB: rawB,
    gameDate: $('gameDate').value || localIsoDate(new Date())
  };
  STAT_KEYS.forEach(function (k) {
    const key = lowerFirst(k);
    lastCalc[key + 'A'] = val(key + 'A');
    lastCalc[key + 'B'] = val(key + 'B');
  });
}

/* ---------------------------- Trade log ---------------------------- */
const LOG_KEY = 'kalshiNbaTradeLog';
function loadLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch (e) { return []; } }
function saveLog(entries) { localStorage.setItem(LOG_KEY, JSON.stringify(entries)); }

function logCurrentTrade() {
  if (!lastCalc) { alert('Fetch both teams\' data first so there\'s a calculated price and edge to log.'); return; }
  const betInput = $('betAmount');
  const stake = parseFloat(betInput.value);
  if (!stake || stake <= 0) { alert('Enter how much you\'re wagering first.'); return; }

  const loggedSide = $('logSideOverride').value || lastCalc.side;
  const loggedModel = loggedSide === 'A' ? lastCalc.modelA : lastCalc.modelB;
  const loggedMarket = loggedSide === 'A' ? lastCalc.marketA : lastCalc.marketB;

  const entries = loadLog();
  entries.push({
    id: Date.now(), date: lastCalc.gameDate,
    matchup: lastCalc.nameA + ' vs ' + lastCalc.nameB,
    side: loggedSide === 'A' ? lastCalc.nameA : lastCalc.nameB,
    price: loggedSide === 'A' ? lastCalc.rawA : lastCalc.rawB,
    model: loggedModel, edge: loggedModel - loggedMarket,
    stakeDollars: stake, result: 'pending'
  });
  saveLog(entries);
  betInput.value = '';
  $('logSideOverride').value = '';
  renderLog();
}

// Point-spread bet, same sign convention as the football page: + means that team is getting points,
// - means giving them. Entered by hand -- the model estimates win probability, not margin.
function logSpreadTrade() {
  const nameA = txt('teamAName'), nameB = txt('teamBName');
  if (!nameA || !nameB) { alert('Enter or fetch both teams first.'); return; }
  const side = $('spreadTeamSide').value;
  const line = parseFloat($('spreadLine').value);
  const priceCents = parseFloat($('spreadPrice').value);
  const betInput = $('betAmount');
  const stake = parseFloat(betInput.value);
  if (isNaN(line)) { alert('Enter the spread (e.g. 4.5 for getting points, -4.5 for giving them).'); return; }
  if (!priceCents || priceCents <= 0 || priceCents >= 100) { alert('Enter a price between 1 and 99 cents.'); return; }
  if (!stake || stake <= 0) { alert('Enter how much you\'re wagering first.'); return; }

  const entries = loadLog();
  entries.push({
    id: Date.now(), date: $('gameDate').value || localIsoDate(new Date()),
    matchup: nameA + ' vs ' + nameB,
    side: side === 'A' ? nameA : nameB,
    betType: 'spread', spreadLine: line,
    price: priceCents / 100, stakeDollars: stake, result: 'pending'
  });
  saveLog(entries);
  betInput.value = ''; $('spreadLine').value = ''; $('spreadPrice').value = '';
  renderLog();
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function importJsonMerge(event, load, save, render, label) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('not an array');
      const existing = load();
      const existingIds = new Set(existing.map(function (e) { return e.id; }));
      save(existing.concat(imported.filter(function (e) { return !existingIds.has(e.id); })));
      render();
      alert('Imported ' + imported.length + ' entries (merged; duplicates skipped).');
    } catch (err) { alert('Could not read that file as a ' + label + ' export.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}
function exportLog() { downloadJson(loadLog(), 'kalshi-nba-trade-log-' + localIsoDate(new Date()) + '.json'); }
function importLog(event) { importJsonMerge(event, loadLog, saveLog, renderLog, 'trade log'); }

// Entries store the game date, but older/hand-edited ones might be off by a day or two, so
// check that date first and then widen out ±3 days.
async function fetchGameResultForTrade(entry) {
  const names = entry.matchup.split(' vs ');
  if (names.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return null;
  for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
    let events;
    try { events = await getScoreboardEvents(shiftIsoDate(entry.date, offset)); } catch (err) { continue; }
    const comp = findGame(events, names);
    if (!comp) continue;
    if (!(comp.status && comp.status.type && comp.status.type.completed)) return 'pending';
    const sideTeam = comp.competitors.find(function (c) { return c.team.displayName === entry.side; });
    const oppTeam = comp.competitors.find(function (c) { return c.team.displayName !== entry.side; });
    if (!sideTeam || !oppTeam) return null;
    if (entry.betType === 'spread') {
      const covered = (parseFloat(sideTeam.score) - parseFloat(oppTeam.score)) + entry.spreadLine;
      if (isNaN(covered)) return null;
      return covered > 0 ? 'win' : (covered < 0 ? 'loss' : 'push');
    }
    return sideTeam.winner ? 'win' : 'loss';
  }
  return null;
}

async function fetchTradeResults() {
  const status = $('fetchResultsStatus');
  const entries = loadLog();
  const pending = entries.filter(function (e) { return e.result === 'pending'; });
  if (!pending.length) { status.textContent = 'No pending trades to check.'; return; }

  status.textContent = 'Checking ' + pending.length + ' pending trade' + (pending.length === 1 ? '' : 's') + '…';
  let updated = 0, notFinal = 0, notFound = 0;
  for (const entry of pending) {
    try {
      const result = await fetchGameResultForTrade(entry);
      if (result === 'win' || result === 'loss' || result === 'push') { entry.result = result; updated++; }
      else if (result === 'pending') notFinal++;
      else notFound++;
    } catch (err) { notFound++; }
  }
  saveLog(entries);
  renderLog();
  status.textContent = '✓ Settled ' + updated + ' trade' + (updated === 1 ? '' : 's') +
    (notFinal ? ' · ' + notFinal + ' game' + (notFinal === 1 ? '' : 's') + ' not final yet' : '') +
    (notFound ? ' · ' + notFound + ' not found (check the matchup/date match a real game)' : '') + '.';
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
  if (entry.result === 'push') return 0;
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
    const isSpread = e.betType === 'spread';
    const modelCell = isSpread ? '—' : fmtNum(e.model * 100, 1) + '%';
    const edgeCell = isSpread
      ? (e.spreadLine >= 0 ? '+' : '') + e.spreadLine.toFixed(1) + ' spread'
      : (e.edge >= 0 ? '+' : '') + (e.edge * 100).toFixed(1) + ' pts';
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + e.date + '</td><td>' + e.matchup + '</td><td>' + e.side + '</td>' +
      '<td>' + Math.round(e.price * 100) + '¢</td><td>' + modelCell + '</td>' +
      '<td>' + edgeCell + '</td>' +
      '<td>$' + e.stakeDollars.toFixed(2) + '</td><td>+$' + toWin.toFixed(2) + '</td><td></td><td></td><td></td>';
    const select = document.createElement('select');
    ['pending', 'win', 'loss', 'push'].forEach(function (opt) {
      const o = document.createElement('option'); o.value = opt; o.textContent = opt;
      if (opt === e.result) o.selected = true; select.appendChild(o);
    });
    select.addEventListener('change', function () { setTradeResult(e.id, select.value); });
    tr.children[8].appendChild(select);
    const plTd = tr.children[9];
    if (pl !== null) {
      plTd.textContent = pl === 0 ? '$0.00 (push)' : (pl > 0 ? '+$' : '-$') + Math.abs(pl).toFixed(2);
      plTd.className = pl > 0 ? 'pos-val' : (pl < 0 ? 'neg-val' : '');
    } else plTd.textContent = '—';
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

/* ---------------------------- Matchup data & analysis ---------------------------- */
const MATCHUP_DATA_KEY = 'kalshiNbaMatchupData';
const STAT_LABELS = { PointDiff: 'Point differential /gm', MissingMin: 'Missing rotation minutes' };
const TRACKED_STATS = STAT_KEYS.map(function (k) {
  return { key: lowerFirst(k), label: STAT_LABELS[k], higherBetter: k !== 'MissingMin' };
}).concat([{ key: 'model', label: 'Model probability', higherBetter: true }, { key: 'market', label: 'Market probability', higherBetter: true }]);

function loadMatchupData() { try { return JSON.parse(localStorage.getItem(MATCHUP_DATA_KEY)) || []; } catch (e) { return []; } }
function saveMatchupData(entries) { localStorage.setItem(MATCHUP_DATA_KEY, JSON.stringify(entries)); }

function recordMatchup() {
  if (!lastCalc) { alert('Fetch both teams\' data first so there\'s a matchup to record.'); return; }
  const entries = loadMatchupData();
  const date = lastCalc.gameDate;
  const alreadyRecorded = entries.some(function (e) {
    return e.date === date && ((e.nameA === lastCalc.nameA && e.nameB === lastCalc.nameB) || (e.nameA === lastCalc.nameB && e.nameB === lastCalc.nameA));
  });
  if (alreadyRecorded && !confirm(lastCalc.nameA + ' vs ' + lastCalc.nameB + ' was already recorded for ' + date + '. Record it again anyway?')) return;
  const entry = {
    id: Date.now(), date: date, nameA: lastCalc.nameA, nameB: lastCalc.nameB, recSide: lastCalc.side, edgePts: lastCalc.edge * 100,
    modelA: lastCalc.modelA, modelB: lastCalc.modelB, marketA: lastCalc.marketA, marketB: lastCalc.marketB,
    homeSide: $('homeSide').value, b2bA: $('b2bA').checked, b2bB: $('b2bB').checked, result: 'pending'
  };
  STAT_KEYS.forEach(function (k) {
    const key = lowerFirst(k);
    entry[key + 'A'] = lastCalc[key + 'A']; entry[key + 'B'] = lastCalc[key + 'B'];
  });
  entries.push(entry);
  saveMatchupData(entries);
  renderMatchupData();
  // The matchup table is at the bottom of the page, so confirm up top too.
  $('recordStatus').textContent = '✓ Recorded ' + entry.nameA + ' vs ' + entry.nameB + ' (' + date + ') — ' +
    entries.length + ' matchup' + (entries.length === 1 ? '' : 's') + ' recorded.';
}
function exportMatchupData() { downloadJson(loadMatchupData(), 'kalshi-nba-matchup-data-' + localIsoDate(new Date()) + '.json'); }
function importMatchupData(event) { importJsonMerge(event, loadMatchupData, saveMatchupData, renderMatchupData, 'matchup data'); }
function setMatchupResult(id, result) {
  const entries = loadMatchupData();
  const e = entries.find(function (x) { return x.id === id; });
  if (e) e.result = result;
  saveMatchupData(entries); renderMatchupData();
}
function deleteMatchup(id) { saveMatchupData(loadMatchupData().filter(function (x) { return x.id !== id; })); renderMatchupData(); }

async function refreshMatchupResults() {
  const btn = $('refreshMatchupBtn');
  const status = $('refreshMatchupStatus');
  const entries = loadMatchupData();
  const pending = entries.filter(function (e) { return e.result === 'pending'; });
  if (!pending.length) { status.textContent = 'No pending matchups to check.'; return; }
  btn.disabled = true;
  let updated = 0, stillPending = 0;
  try {
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      status.textContent = 'Checking ' + (i + 1) + ' of ' + pending.length + ' pending matchup(s) — ' + e.nameA + ' vs ' + e.nameB + '…';
      try {
        const comp = findGame(await getScoreboardEvents(e.date), [e.nameA, e.nameB]);
        if (!comp || !(comp.status && comp.status.type && comp.status.type.completed)) { stillPending++; continue; }
        const winner = comp.competitors.find(function (c) { return c.winner; });
        if (!winner) { stillPending++; continue; }
        e.result = winner.team.displayName === e.nameA ? 'A' : 'B';
        updated++;
      } catch (err) { stillPending++; }
    }
    saveMatchupData(entries);
    renderMatchupData();
    status.textContent = '✓ Checked ' + pending.length + ' pending matchup(s) — ' + updated + ' updated' +
      (stillPending ? ', ' + stillPending + ' still not final (or not found on that date)' : '') + '.';
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
  const settled = entries.filter(function (e) { return e.result === 'A' || e.result === 'B'; });
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
  const tbody = $('statAccuracyTbody');
  tbody.innerHTML = '';
  computeStatAccuracy(loadMatchupData()).forEach(function (s) {
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

/* ---------------------------- Clear All Data (hold-to-confirm) ---------------------------- */
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
// Any input/select change anywhere on the page re-runs the model -- one delegated listener
// instead of wiring each field.
document.addEventListener('input', function (e) { if (e.target.matches('input, select')) recalc(); });
document.addEventListener('change', function (e) { if (e.target.matches('input[type="checkbox"], select')) recalc(); });
$('teamAName').addEventListener('blur', function () { resolveAndBadge('A'); });
$('teamBName').addEventListener('blur', function () { resolveAndBadge('B'); });
$('gameDate').value = localIsoDate(new Date());
getNbaTeams().catch(function () {});
resolveAndBadge('A'); resolveAndBadge('B');
recalc();
renderLog();
renderMatchupData();
