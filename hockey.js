/* =======================================================================
   Kalshi NHL Value Model.
   Team composite: 7 season-to-date team stats from the NHL's own stats API
   (proxied + aggregated server-side -- it sends no CORS headers), plus two
   matchup-context terms (home ice, back-to-back) read off ESPN's schedule.
   Weights are each signal's |r| with winning across 18,803 team-games
   (2018-19 to 2025-26, nhl_game_predictor_pipeline.py), with redundant stats
   folded into one score each, plus the starting goalie's shrunk save % (nhl_goalie_test.py).
   Corsi/faceoffs can be adjusted for tonight's injuries from the lineup route. Trade log / matchup data / accuracy tracking
   mirror the football model.
   ======================================================================= */

let lastCalc = null;
let nhlTeamsCache = null;
let lastFetchedSeason = { A: null, B: null }; // e.g. "20252026" -- which season each side's stats came from
let injuryAdjust = { A: null, B: null }; // from the lineup route: { corsi, faceoff } deltas in percentage points, tonight vs full strength

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
function fmtSeason(id) { return id ? id.slice(0, 4) + '-' + id.slice(6, 8) : ''; }

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
async function espnGet(path) { return fetchJson('/api/espn/nhl-site' + path); }
async function teamSummaryGet(teamName) {
  // Server tries the current NHL season first and falls back to the prior one if it has no games.
  return fetchJson('/api/nhl/team-summary/' + encodeURIComponent(teamName));
}

/* ---------------------------- team resolution ---------------------------- */
async function getNhlTeams() {
  if (nhlTeamsCache) return nhlTeamsCache;
  const data = await espnGet('/teams?limit=40');
  nhlTeamsCache = data.sports[0].leagues[0].teams.map(t => t.team);
  return nhlTeamsCache;
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
    const team = findTeam(name, await getNhlTeams());
    if (team) applyTeamBadge(side, team);
  } catch (e) { /* cosmetic only */ }
}

/* ---------------------------- game context: home ice + back-to-backs from ESPN's schedule ---------------------------- */
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
  if (!game) return 'no ' + teamA.shortDisplayName + '–' + teamB.shortDisplayName + ' game found on ' + date + ' — check home ice';
  const home = game.competitors.find(function (c) { return c.homeAway === 'home'; });
  if (game.neutralSite) $('homeSide').value = '';
  else if (home) $('homeSide').value = home.team.displayName === teamA.displayName ? 'A' : 'B';
  return 'game found on ' + date;
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
    const teams = await getNhlTeams();
    const teamA = findTeam(nameA, teams), teamB = findTeam(nameB, teams);
    if (!teamA || !teamB) { status.textContent = 'Could not match one or both team names.'; return; }
    $('teamAName').value = teamA.displayName;
    $('teamBName').value = teamB.displayName;
    applyTeamBadge('A', teamA);
    applyTeamBadge('B', teamB);

    injuryAdjust = { A: null, B: null };
    ['A', 'B'].forEach(function (sd) { $('goalieSv' + sd).value = $('goalieSvMean').value; $('goalieSel' + sd).innerHTML = '<option value="">Loading…</option>'; });
    loadLineups(teamA, teamB); // separate from the stats so a slow lineup never holds up the model

    status.textContent = 'Fetching team season stats and schedule…';
    const [summaryA, summaryB, contextNote] = await Promise.all([
      teamSummaryGet(teamA.displayName).catch(function () { return null; }),
      teamSummaryGet(teamB.displayName).catch(function () { return null; }),
      applyGameContext(teamA, teamB).catch(function (err) { return 'schedule lookup failed (' + err.message + ') — check home/back-to-back'; })
    ]);
    applyTeamSummaryToInputs('A', summaryA);
    applyTeamSummaryToInputs('B', summaryB);
    recalc();

    const missing = [!summaryA && teamA.displayName, !summaryB && teamB.displayName].filter(Boolean);
    status.textContent = (missing.length ? '⚠ No stats for ' + missing.join(' & ') + '. ' : '✓ ') +
      'Loaded ' + teamA.displayName + ' vs ' + teamB.displayName + '. Stats: ' +
      (fmtSeason(lastFetchedSeason.A) || '?') + ' / ' + (fmtSeason(lastFetchedSeason.B) || '?') + ' season' +
      blendNote(summaryA, summaryB) + '. Context: ' + contextNote + '.';
  } catch (err) {
    status.textContent = 'Fetch failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------- lineups + injuries ---------------------------- */
// Estimated from season ice time server-side (the NHL publishes no official line combinations
// and ESPN's hockey depth chart is empty). An injured regular keeps the slot his minutes earned,
// struck through, rather than being silently replaced by whoever is filling in.
const DTD_STATUSES = ['day-to-day', 'questionable', 'probable'];
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function playerHtml(p, slot, extraClass) {
  if (!p) return slot ? '<span class="depth-slot">' + slot + '</span><span class="depth-player backup">—</span>' : '';
  const cls = p.inactive ? 'inactive' : (extraClass || '');
  const tagCls = p.injury && DTD_STATUSES.indexOf(p.injury.toLowerCase()) !== -1 ? 'injury-tag dtd' : 'injury-tag';
  const tag = p.injury ? '<span class="' + tagCls + '" title="' + escapeHtml(p.injuryDetail || '') + '">' + escapeHtml(p.injury) + '</span>' : '';
  const stat = p.starts !== undefined ? p.starts + ' GS' : (p.toi ? p.toi.toFixed(1) + ' min' : '');
  return (slot ? '<span class="depth-slot">' + slot + '</span>' : '') +
    '<span class="depth-player ' + cls + '">' + escapeHtml(p.name) + '</span>' +
    (stat ? '<span class="depth-toi">' + stat + '</span>' : '') + tag;
}
function lineupBlockHtml(name, lu) {
  if (!lu || lu.error) return '<div><h3>' + escapeHtml(name) + '</h3><div class="fetch-status">Lineup unavailable' + (lu && lu.error ? ': ' + escapeHtml(lu.error) : '') + '.</div></div>';
  const row = function (label, inner) { return '<div class="depth-pos-row"><span class="depth-pos-label">' + label + '</span>' + inner + '</div>'; };
  let html = '<div><h3>' + escapeHtml(name) + ' &mdash; Forwards</h3>';
  lu.forwardLines.forEach(function (line, i) {
    html += row('L' + (i + 1), ['LW', 'C', 'RW'].map(function (s) { return playerHtml(line[s], s); }).join(' &middot; '));
  });
  html += '<h3>Defense</h3>';
  lu.defensePairs.forEach(function (pair, i) {
    html += row('D' + (i + 1), pair.map(function (p) { return playerHtml(p); }).join(' &middot; '));
  });
  html += '<h3>Goalies</h3>';
  html += row('G', lu.goalies.map(function (g, i) { return playerHtml(g, i === 0 ? 'Starter' : 'Backup', i === 0 ? '' : 'backup'); }).join(' &middot; '));
  if (lu.extras && lu.extras.length) {
    html += row('Ext', lu.extras.map(function (p) { return playerHtml(p, null, 'backup'); }).join(' &middot; '));
  }
  return html + '</div>';
}
// Starting goalies are usually confirmed the morning of the game -- default to the healthy goalie
// with the most starts and let the user switch to whoever's actually announced.
let goalieOptions = { A: [], B: [] };
function fillGoaliePicker(side, lu) {
  const sel = $('goalieSel' + side);
  goalieOptions[side] = (lu && lu.goalieOptions) || [];
  sel.innerHTML = '';
  goalieOptions[side].forEach(function (g, i) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = g.name + (g.savePct ? ' — ' + (g.savePct * 100).toFixed(1) : '') + (g.inactive ? ' (' + g.injury + ')' : '') +
      ' · ' + g.starts + ' GS';
    sel.appendChild(o);
  });
  if (!goalieOptions[side].length) { sel.innerHTML = '<option value="">No goalies found</option>'; return; }
  const healthy = goalieOptions[side].findIndex(function (g) { return !g.inactive; });
  sel.value = String(healthy === -1 ? 0 : healthy);
  applyGoalieChoice(side);
}
function applyGoalieChoice(side) {
  const g = goalieOptions[side][parseInt($('goalieSel' + side).value, 10)];
  if (g && g.savePct) $('goalieSv' + side).value = (g.savePct * 100).toFixed(2);
}

async function loadLineups(teamA, teamB) {
  const status = $('depthChartStatus');
  status.textContent = 'Loading lineups and injuries…';
  $('depthChartGrid').innerHTML = '';
  const get = function (t) {
    return fetchJson('/api/nhl/lineup/' + encodeURIComponent(t.abbreviation)).catch(function (err) { return { error: err.message }; });
  };
  const [luA, luB] = await Promise.all([get(teamA), get(teamB)]);
  // A newer fetch may have started while this one was in flight -- don't overwrite it.
  if (txt('teamAName') !== teamA.displayName || txt('teamBName') !== teamB.displayName) return;
  $('depthChartGrid').innerHTML = lineupBlockHtml(teamA.displayName, luA) + lineupBlockHtml(teamB.displayName, luB);
  const toPts = function (lu) {
    const a = lu && lu.injuryAdjust;
    return a ? { corsi: a.corsi * 100, faceoff: a.faceoff * 100, out: a.out || [], replacements: a.replacements || [] } : null;
  };
  injuryAdjust = { A: toPts(luA), B: toPts(luB) };
  fillGoaliePicker('A', luA);
  fillGoaliePicker('B', luB);
  recalc();
  const note = (luA && luA.seasonNote) || (luB && luB.seasonNote) || '';
  status.textContent = (luA.error || luB.error ? '⚠ ' : '✓ ') + 'Lines estimated from average ice time (' + note +
    ') — not official line combos. Struck through = out (IR / suspended); yellow tag = day-to-day.';
}

// Early in a season the server blends in last season as 15 games' worth (backtested) -- say how much.
function blendNote(a, b) {
  const parts = [a, b].filter(function (x) { return x && x.priorSeasonWeight; })
    .map(function (x) { return x.team.split(' ').pop() + ' ' + Math.round(x.priorSeasonWeight * 100) + '%'; });
  return parts.length ? ', blended with last season (' + parts.join(', ') + ' last-season weight, fading as games are played)' : '';
}

// Server sends fractions (0.49); the page shows percentages (49.0) since that's how they're quoted.
function applyTeamSummaryToInputs(side, s) {
  if (!s) return;
  lastFetchedSeason[side] = s.season;
  const pct = function (x) { return (x === null || x === undefined) ? null : x * 100; };
  $('corsi' + side).value = fmtNum(pct(s.corsiPct), 1);
  $('goalDiff' + side).value = fmtNum(s.goalDiffPerGame, 2);
  $('winPct' + side).value = fmtNum(pct(s.winPct), 1);
  $('zoneStart' + side).value = fmtNum(pct(s.zoneStartPct), 1);
  $('powerPlay' + side).value = fmtNum(pct(s.powerPlayPct), 1);
  $('netPen' + side).value = fmtNum(s.netPenaltiesPer60, 2);
  $('faceoff' + side).value = fmtNum(pct(s.faceoffPct), 1);
}

/* ---------------------------- team composite (Team Strength Index) + recalc ---------------------------- */
const TSI_KEYS = ['Corsi', 'GoalDiff', 'WinPct', 'ZoneStart', 'Home', 'PowerPlay', 'GoalieSv', 'NetPen', 'B2b', 'Faceoff'];
const STAT_KEYS = ['Corsi', 'GoalDiff', 'WinPct', 'ZoneStart', 'PowerPlay', 'GoalieSv', 'NetPen', 'Faceoff']; // per-team inputs
const BASE_KEYS = ['corsiMean', 'corsiSd', 'goalDiffMean', 'goalDiffSd', 'winPctMean', 'winPctSd', 'zoneStartMean', 'zoneStartSd',
  'powerPlayMean', 'powerPlaySd', 'goalieSvMean', 'goalieSvSd', 'netPenMean', 'netPenSd', 'faceoffMean', 'faceoffSd', 'homeZ', 'b2bZ'];
function lowerFirst(k) { return k.charAt(0).toLowerCase() + k.slice(1); }

// Home ice and back-to-back are indicators, not stats, so their "z" is a fitted magnitude
// (homeZ / b2bZ in Advanced) rather than a (value - mean) / sd -- the calibration fit found
// plain 0/1 indicators badly under-predicted both effects at these correlation-sized weights.
// The season stat as entered, plus tonight's injury delta for the two stats the lineup route
// can adjust (Corsi % and faceoff %) when the toggle is on.
function statValue(key, side) {
  const adj = injuryAdjust[side];
  const delta = (adj && $('injuryAdjustOn').checked && adj[key] !== undefined) ? adj[key] : 0;
  return val(key + side) + delta;
}
function renderInjuryAdjustNotes() {
  ['A', 'B'].forEach(function (side) {
    [['corsi', 'Corsi'], ['faceoff', 'Faceoff']].forEach(function (pair) {
      const el = $('adj' + pair[1] + side);
      const adj = injuryAdjust[side];
      const d = adj ? adj[pair[0]] : 0;
      if (!adj || !$('injuryAdjustOn').checked || Math.abs(d) < 0.005) { el.textContent = ''; el.title = ''; return; }
      el.textContent = '→ ' + statValue(pair[0], side).toFixed(1) + ' tonight';
      el.title = (d >= 0 ? '+' : '') + d.toFixed(2) + ' pts with ' + adj.out.join(', ') + ' out' +
        (adj.replacements.length ? ' (' + adj.replacements.join(', ') + ' in)' : '');
    });
  });
}

function compositeTSI(side, w, base) {
  const contributions = {};
  STAT_KEYS.forEach(function (k) {
    const key = lowerFirst(k);
    contributions[k] = w[k] * z(statValue(key, side), base[key + 'Mean'], base[key + 'Sd']);
  });
  const homeSide = $('homeSide').value;
  contributions.Home = w.Home * (homeSide === side ? base.homeZ : (homeSide ? -base.homeZ : 0));
  contributions.B2b = w.B2b * ($('b2b' + side).checked ? -base.b2bZ : 0);
  let total = 0;
  Object.keys(contributions).forEach(function (k) { total += contributions[k]; });
  return { total: total, contributions: contributions };
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
  TSI_KEYS.forEach(function (k) { paintContribBadge('contrib' + k + side, c[k]); });
}

function recalc() {
  const nameA = txt('teamAName') || 'Team A', nameB = txt('teamBName') || 'Team B';
  $('cardATitle').textContent = nameA + ' — ' + (lastFetchedSeason.A ? fmtSeason(lastFetchedSeason.A) + ' ' : '') + 'Season Stats';
  $('cardBTitle').textContent = nameB + ' — ' + (lastFetchedSeason.B ? fmtSeason(lastFetchedSeason.B) + ' ' : '') + 'Season Stats';
  $('resATitle').textContent = nameA;
  $('resBTitle').textContent = nameB;
  $('logSideOptA').textContent = nameA; $('logSideOptB').textContent = nameB;
  $('spreadOptA').textContent = nameA; $('spreadOptB').textContent = nameB;
  $('homeOptA').textContent = nameA + ' home'; $('homeOptB').textContent = nameB + ' home';
  $('b2bALabel').textContent = nameA + ' on back-to-back';
  $('b2bBLabel').textContent = nameB + ' on back-to-back';

  const w = weights('w', TSI_KEYS);
  const base = {};
  BASE_KEYS.forEach(function (k) { base[k] = val(k); });
  const scale = val('scale');

  const resultA = compositeTSI('A', w, base);
  const resultB = compositeTSI('B', w, base);
  const impliedA = logistic(resultA.total, scale), impliedB = logistic(resultB.total, scale);
  const modelA = log5(impliedA, impliedB), modelB = 1 - modelA;
  renderInjuryAdjustNotes();
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
    lastCalc[key + 'A'] = statValue(key, 'A'); // what the model actually used (injury-adjusted if on)
    lastCalc[key + 'B'] = statValue(key, 'B');
  });
}

/* ---------------------------- Trade log ---------------------------- */
const LOG_KEY = 'kalshiNhlTradeLog';
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

// Puck line = hockey's point spread, almost always ±1.5. Same sign convention as the football
// spread log: + means that team is getting goals, − means giving them. No model probability for
// it (the composite estimates win probability, not margin), so it's entered by hand.
function logSpreadTrade() {
  const nameA = txt('teamAName'), nameB = txt('teamBName');
  if (!nameA || !nameB) { alert('Enter or fetch both teams first.'); return; }
  const side = $('spreadTeamSide').value;
  const line = parseFloat($('spreadLine').value);
  const priceCents = parseFloat($('spreadPrice').value);
  const betInput = $('betAmount');
  const stake = parseFloat(betInput.value);
  if (isNaN(line)) { alert('Enter the puck line (e.g. 1.5 for getting goals, -1.5 for giving them).'); return; }
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
function exportLog() { downloadJson(loadLog(), 'kalshi-nhl-trade-log-' + localIsoDate(new Date()) + '.json'); }
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
      // ESPN's final score already credits the shootout winner with the deciding goal.
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
      ? (e.spreadLine >= 0 ? '+' : '') + e.spreadLine.toFixed(1) + ' puck line'
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
const MATCHUP_DATA_KEY = 'kalshiNhlMatchupData';
const STAT_LABELS = { Corsi: 'Corsi %', GoalDiff: 'Goal diff /gm', WinPct: 'Win %', ZoneStart: 'Zone start %',
  PowerPlay: 'Power play %', GoalieSv: 'Starting goalie save %', NetPen: 'Net penalties /60', Faceoff: 'Faceoff %' };
const TRACKED_STATS = STAT_KEYS.map(function (k) {
  return { key: lowerFirst(k), label: STAT_LABELS[k], higherBetter: true }; // every hockey input is higher-is-better
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
}
function exportMatchupData() { downloadJson(loadMatchupData(), 'kalshi-nhl-matchup-data-' + localIsoDate(new Date()) + '.json'); }
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
$('goalieSelA').addEventListener('change', function () { applyGoalieChoice('A'); recalc(); });
$('goalieSelB').addEventListener('change', function () { applyGoalieChoice('B'); recalc(); });
$('teamAName').addEventListener('blur', function () { resolveAndBadge('A'); });
$('teamBName').addEventListener('blur', function () { resolveAndBadge('B'); });
$('gameDate').value = localIsoDate(new Date());
getNhlTeams().catch(function () {});
resolveAndBadge('A'); resolveAndBadge('B');
recalc();
renderLog();
renderMatchupData();
