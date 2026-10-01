"""
Kalshi Value Models -- server.

Serves the static frontend (index.html, value_model.html, football.html, hockey.html) AND
proxies the football model's data sources, neither of which support CORS so
neither can be called directly from the browser like MLB Stats API is for
the baseball model:

  - ESPN's hidden API -- rosters, depth charts, injuries, individual player
    stats, team box-score-style stats, schedule.
  - nflverse's team-week stats + schedules (GitHub release assets) -- real
    EPA numbers, which ESPN's API doesn't expose anywhere. Downloaded once
    per season and cached in memory since this only changes ~weekly.

The baseball model (value_model.html) needs none of this -- it keeps calling
MLB's Stats API directly from the browser exactly as before. This server is
purely additive for football.
"""
import os
import csv
import io
import json
import time
import unicodedata
import concurrent.futures
from datetime import datetime
from flask import Flask, request, jsonify, Response, send_from_directory
import requests

app = Flask(__name__, static_folder='.', static_url_path='')

ESPN_SITE_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'
ESPN_WEB_API = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl'
ESPN_CORE_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl'

ESPN_CFB_SITE_API = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football'
ESPN_CFB_WEB_API = 'https://site.web.api.espn.com/apis/common/v3/sports/football/college-football'

NFLVERSE_STATS_TEAM = 'https://github.com/nflverse/nflverse-data/releases/download/stats_team'
NFLVERSE_SCHEDULES = 'https://github.com/nflverse/nflverse-data/releases/download/schedules'

CFBD_API = 'https://api.collegefootballdata.com'

ESPN_NHL_SITE_API = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl'
NHL_STATS_API = 'https://api.nhle.com/stats/rest/en/team'
NHL_WEB_API = 'https://api-web.nhle.com/v1'


def _load_cfbd_key():
    """CFBD needs a free API key (unlike ESPN/nflverse). Checked in order: a real env var
    (for prod-style deploys), then a local cfbd_api_key.txt next to this file (gitignored --
    never committed) for simple local runs. Returns None if neither is set; CFB routes then
    fail with a clear error instead of a confusing 401 from CFBD."""
    env_key = os.environ.get('CFBD_API_KEY')
    if env_key:
        return env_key.strip()
    key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cfbd_api_key.txt')
    if os.path.exists(key_path):
        with open(key_path, 'r', encoding='utf-8') as f:
            return f.read().strip()
    return None


CFBD_API_KEY = _load_cfbd_key()

REQUEST_TIMEOUT = 15
CACHE_TTL = 3600  # seconds -- nflverse/CFBD data updates at most ~weekly during the season


# ---------------------------------------------------------------- static frontend

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


# This app is under active iteration -- without this, browsers happily keep serving a stale
# cached copy of football.js/football.html even after the server restarts with new code,
# which looks exactly like "nothing changed" when you're actually just running old JS.
@app.after_request
def _no_cache(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return response


# ---------------------------------------------------------------- generic ESPN proxies
# Passthrough -- any ESPN endpoint under these three bases works without touching this
# file again. Frontend calls e.g. /api/espn/site/teams/ne/roster.

def _proxy_get(base, subpath):
    try:
        r = requests.get(base + '/' + subpath, params=request.args, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as e:
        return jsonify({'error': 'Upstream request failed: ' + str(e)}), 502
    return Response(r.content, status=r.status_code, content_type=r.headers.get('Content-Type', 'application/json'))


@app.route('/api/espn/site/<path:subpath>')
def espn_site_proxy(subpath):
    return _proxy_get(ESPN_SITE_API, subpath)


@app.route('/api/espn/web/<path:subpath>')
def espn_web_proxy(subpath):
    return _proxy_get(ESPN_WEB_API, subpath)


@app.route('/api/espn/core/<path:subpath>')
def espn_core_proxy(subpath):
    return _proxy_get(ESPN_CORE_API, subpath)


# ---------------------------------------------------------------- college football (ESPN + CFBD)

@app.route('/api/espn/cfb-site/<path:subpath>')
def espn_cfb_site_proxy(subpath):
    return _proxy_get(ESPN_CFB_SITE_API, subpath)


@app.route('/api/espn/cfb-web/<path:subpath>')
def espn_cfb_web_proxy(subpath):
    return _proxy_get(ESPN_CFB_WEB_API, subpath)


@app.route('/api/cfbd/<path:subpath>')
def cfbd_proxy(subpath):
    """Generic CollegeFootballData.com passthrough. The API key is injected here, server-side
    only -- it's read from cfbd_api_key.txt (gitignored) or the CFBD_API_KEY env var and never
    sent to or visible from the browser. Cached (see _cached_cfbd_bytes below) -- a college
    matchup fetch hits CFBD 14+ times (7 stat categories x 2 teams), and CFBD data changes at
    most weekly, so re-fetching the same team within the hour is pure waste."""
    if not CFBD_API_KEY:
        return jsonify({'error': 'No CFBD API key configured on the server (set CFBD_API_KEY or add cfbd_api_key.txt).'}), 500
    cache_key = 'cfbd:' + subpath + '?' + str(sorted(request.args.items()))
    try:
        content, status, content_type = _cached_cfbd_bytes(cache_key, subpath, request.args)
    except requests.RequestException as e:
        return jsonify({'error': 'CFBD request failed: ' + str(e)}), 502
    return Response(content, status=status, content_type=content_type)


# ---------------------------------------------------------------- nflverse team EPA/yards/turnovers
# In-memory cache -- these files are small (a few hundred KB) but there's no reason to
# re-download and re-parse them on every request within the same hour.
_cache = {}  # key -> {'data': ..., 'fetched_at': ...}


def _cached_csv_rows(cache_key, url):
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached['fetched_at']) < CACHE_TTL:
        return cached['data']
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    _cache[cache_key] = {'data': rows, 'fetched_at': time.time()}
    return rows


def _cached_cfbd_bytes(cache_key, subpath, params):
    """Same idea as _cached_csv_rows, for CFBD's raw JSON responses -- caches the response
    bytes/status/content-type as-is so both the generic proxy and _cfbd_get (JSON-parsed,
    used internally for the team-summary computation) share one cache."""
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached['fetched_at']) < CACHE_TTL:
        return cached['content'], cached['status'], cached['content_type']
    r = requests.get(
        CFBD_API + '/' + subpath,
        params=params,
        headers={'Authorization': 'Bearer ' + CFBD_API_KEY},
        timeout=REQUEST_TIMEOUT,
    )
    content_type = r.headers.get('Content-Type', 'application/json')
    _cache[cache_key] = {'content': r.content, 'status': r.status_code, 'content_type': content_type, 'fetched_at': time.time()}
    return r.content, r.status_code, content_type


def _num(row, key):
    try:
        return float(row.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def _current_nfl_season():
    """NFL seasons are named for the year they kick off in (e.g. games in Jan/Feb 2027 are
    still "2026 season" games), so January/February roll over to the *previous* year's label."""
    now = datetime.utcnow()
    return str(now.year if now.month >= 3 else now.year - 1)


def _compute_team_summary(team, season):
    """Returns the per-game team-summary dict for one team/season, or None if that season
    has no played games yet for this team (e.g. the current season hasn't started)."""
    week_rows = _cached_csv_rows(
        'stats_team_week_' + season,
        NFLVERSE_STATS_TEAM + '/stats_team_week_' + season + '.csv'
    )
    games = _cached_csv_rows('games', NFLVERSE_SCHEDULES + '/games.csv')

    own_rows = [r for r in week_rows if r.get('team') == team and r.get('season') == season]
    opp_rows = [r for r in week_rows if r.get('opponent_team') == team and r.get('season') == season]
    team_games = [
        g for g in games
        if g.get('season') == season and g.get('game_type') == 'REG'
        and (g.get('home_team') == team or g.get('away_team') == team)
        and g.get('home_score')  # only games that have actually been played
    ]

    gp = len(own_rows)
    if gp == 0:
        return None

    off_pass_yards = sum(_num(r, 'passing_yards') for r in own_rows)
    off_rush_yards = sum(_num(r, 'rushing_yards') for r in own_rows)
    off_pass_epa = sum(_num(r, 'passing_epa') for r in own_rows)
    off_rush_epa = sum(_num(r, 'rushing_epa') for r in own_rows)
    giveaways = sum(_num(r, 'passing_interceptions') + _num(r, 'fumbles_lost_total') for r in own_rows)
    takeaways = sum(_num(r, 'def_interceptions') + _num(r, 'fumble_recovery_opp') for r in own_rows)
    sacks_suffered = sum(_num(r, 'sacks_suffered') for r in own_rows)  # own O-line's pass-block proxy
    passing_cpoe = sum(_num(r, 'passing_cpoe') for r in own_rows)  # completion % over expected -- QB accuracy, distinct signal from raw EPA/yards
    punt_attempts = sum(_num(r, 'pt_att') for r in own_rows)  # bad-offense proxy -- correlates with losing even more strongly than turnover margin
    def_qb_hits = sum(_num(r, 'def_qb_hits') for r in own_rows)  # pass-rush pressure, own defense generating it (distinct from sacks_suffered, which is this team's OWN offense getting hit)

    def_pass_yards_allowed = sum(_num(r, 'passing_yards') for r in opp_rows)
    def_rush_yards_allowed = sum(_num(r, 'rushing_yards') for r in opp_rows)
    def_pass_epa_allowed = sum(_num(r, 'passing_epa') for r in opp_rows)
    def_rush_epa_allowed = sum(_num(r, 'rushing_epa') for r in opp_rows)

    points_for = sum(float(g['home_score']) if g['home_team'] == team else float(g['away_score']) for g in team_games)
    points_against = sum(float(g['away_score']) if g['home_team'] == team else float(g['home_score']) for g in team_games)
    games_played_for_points = len(team_games) or gp  # fall back to gp if schedule join found nothing

    off_total_yards = off_pass_yards + off_rush_yards
    def_total_yards_allowed = def_pass_yards_allowed + def_rush_yards_allowed
    off_epa = off_pass_epa + off_rush_epa
    def_epa_allowed = def_pass_epa_allowed + def_rush_epa_allowed

    def per_game(total, denom=gp):
        return total / denom if denom else None

    return {
        'team': team,
        'season': season,
        'gamesPlayed': gp,
        'epaDifferential': per_game(off_epa - def_epa_allowed),
        'pointsFor': per_game(points_for, games_played_for_points),
        'pointsAgainst': per_game(points_against, games_played_for_points),
        'turnoverMargin': per_game(takeaways - giveaways),
        'offPassingEpa': per_game(off_pass_epa),
        'defEpaAllowed': per_game(def_epa_allowed),
        'totalYardsDiff': per_game(off_total_yards - def_total_yards_allowed),
        'offRushEpa': per_game(off_rush_epa),
        'offRushYards': per_game(off_rush_yards),
        'defRushYardsAllowed': per_game(def_rush_yards_allowed),
        'offTotalYards': per_game(off_total_yards),
        'defTotalYardsAllowed': per_game(def_total_yards_allowed),
        'defPassYardsAllowed': per_game(def_pass_yards_allowed),
        'offPassingYards': per_game(off_pass_yards),
        'sacksSuffered': per_game(sacks_suffered),  # O-line pass-block proxy -- lower is better
        'passingCpoe': per_game(passing_cpoe),
        'puntAttempts': per_game(punt_attempts),  # bad-offense proxy -- lower is better
        'defQbHits': per_game(def_qb_hits),
    }


def _current_cfb_season():
    return _current_nfl_season()  # same Jan/Feb season-label rollover applies to college too


def _cfbd_get(subpath, params):
    """JSON-parsed, cached CFBD GET -- shares the same cache as the generic proxy route, so a
    team already looked up once (e.g. a common opponent across several matchups) comes back
    instantly for the rest of the hour instead of hitting CFBD's live API again."""
    cache_key = 'cfbd:' + subpath + '?' + str(sorted(params.items()))
    content, status, _ = _cached_cfbd_bytes(cache_key, subpath, params)
    if status >= 400:
        raise requests.HTTPError('CFBD returned ' + str(status) + ' for ' + subpath)
    return json.loads(content)


def _compute_cfb_team_summary(team, season):
    """Same field shape as _compute_team_summary (NFL) so the frontend's composite/weight math
    is reusable almost as-is for college -- built from CFBD's /ppa/teams (EPA-equivalent,
    already per-play so used directly, no per-game division needed), /stats/season (season
    totals, divided by games for per-game rates), and /games (points for/against, since CFBD
    has no direct points-per-season stat -- same reason the NFL version sums nflverse's
    games.csv instead of trying to derive points from counting stats). These three calls are
    independent, so they're fired concurrently rather than one after another -- otherwise a
    single team-summary request pays for three sequential CFBD round-trips end to end."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        ppa_future = ex.submit(_cfbd_get, 'ppa/teams', {'year': season, 'team': team})
        season_future = ex.submit(_cfbd_get, 'stats/season', {'year': season, 'team': team})
        games_future = ex.submit(_cfbd_get, 'games', {'year': season, 'team': team})
        ppa = ppa_future.result()
        season_rows = season_future.result()
        games = games_future.result()

    if not ppa:
        return None
    p = ppa[0]
    off, defn = p.get('offense') or {}, p.get('defense') or {}

    stats = {r['statName']: r['statValue'] for r in season_rows}
    gp = stats.get('games')
    if not gp:
        return None

    played = [g for g in games if g.get('completed')]
    points_for = sum((g['homePoints'] if g['homeTeam'] == team else g['awayPoints']) or 0 for g in played)
    points_against = sum((g['awayPoints'] if g['homeTeam'] == team else g['homePoints']) or 0 for g in played)
    games_for_points = len(played) or gp

    def per_game(total, denom=gp):
        return (total / denom) if denom else None

    off_total_yards = stats.get('totalYards', 0) or 0
    def_total_yards = stats.get('totalYardsOpponent', 0) or 0

    return {
        'team': team,
        'season': str(season),
        'gamesPlayed': gp,
        'epaDifferential': (off.get('overall') or 0) - (defn.get('overall') or 0),
        'pointsFor': per_game(points_for, games_for_points),
        'pointsAgainst': per_game(points_against, games_for_points),
        'turnoverMargin': per_game((stats.get('turnoversOpponent', 0) or 0) - (stats.get('turnovers', 0) or 0)),
        'offPassingEpa': off.get('passing'),
        'defEpaAllowed': defn.get('overall'),
        'totalYardsDiff': per_game(off_total_yards - def_total_yards),
        'offRushEpa': off.get('rushing'),
        'offRushYards': per_game(stats.get('rushingYards', 0) or 0),
        'defRushYardsAllowed': per_game(stats.get('rushingYardsOpponent', 0) or 0),
        'offTotalYards': per_game(off_total_yards),
        'defTotalYardsAllowed': per_game(def_total_yards),
        'defPassYardsAllowed': per_game(stats.get('netPassingYardsOpponent', 0) or 0),
        'offPassingYards': per_game(stats.get('netPassingYards', 0) or 0),
        'sacksSuffered': per_game(stats.get('sacksOpponent', 0) or 0),  # opponent's sacks vs. this team = this team's O-line allowed
    }


@app.route('/api/cfb/team-summary/<team>')
def cfb_team_summary(team):
    """Same auto-fallback pattern as the NFL route: current CFB season first, prior completed
    season if the current one has no games yet."""
    if not CFBD_API_KEY:
        return jsonify({'error': 'No CFBD API key configured on the server (set CFBD_API_KEY or add cfbd_api_key.txt).'}), 500
    season_param = request.args.get('season')
    current = _current_cfb_season()
    seasons_to_try = [season_param] if season_param else [current, str(int(current) - 1)]

    last_error = None
    for season in seasons_to_try:
        try:
            result = _compute_cfb_team_summary(team, season)
        except requests.RequestException as e:
            last_error = e
            continue
        if result:
            return jsonify(result)
    if last_error:
        return jsonify({'error': 'CFBD request failed: ' + str(last_error)}), 502
    return jsonify({'error': 'No games found for ' + team + ' in ' + ' or '.join(seasons_to_try)}), 404


# The frontend resolves teams through ESPN, whose abbreviations differ from nflverse's for
# exactly these two teams -- without this the Rams and Commanders silently got no team stats.
ESPN_TO_NFLVERSE_TEAM = {'LAR': 'LA', 'WSH': 'WAS'}


@app.route('/api/nfl/team-summary/<team>')
def team_summary(team):
    """
    Aggregates nflverse's per-team-per-week stats (+ game scores) into the season
    totals/per-game rates the football model's Team Strength composite needs --
    points for/against, EPA (offense and defense-allowed, overall/pass/rush),
    yards (same split), and turnover margin. All per-game, all season-to-date.

    No ?season= given: tries the current NFL season first and automatically falls
    back to the prior completed season if the current one has no played games yet
    (e.g. it's still preseason) -- so ratings run on 2025 until 2026 has real games,
    then switch over on their own with no code change needed.
    """
    team = team.upper()
    team = ESPN_TO_NFLVERSE_TEAM.get(team, team)
    season_param = request.args.get('season')
    current = _current_nfl_season()
    seasons_to_try = [season_param] if season_param else [current, str(int(current) - 1)]

    last_error = None
    for season in seasons_to_try:
        try:
            result = _compute_team_summary(team, season)
        except requests.RequestException as e:
            last_error = e
            continue
        except requests.HTTPError as e:
            last_error = e
            continue
        if result:
            return jsonify(result)
    if last_error:
        return jsonify({'error': 'nflverse request failed: ' + str(last_error)}), 502
    return jsonify({'error': 'No games found for ' + team + ' in ' + ' or '.join(seasons_to_try)}), 404


# ---------------------------------------------------------------- hockey (ESPN + NHL stats API)

@app.route('/api/espn/nhl-site/<path:subpath>')
def espn_nhl_site_proxy(subpath):
    return _proxy_get(ESPN_NHL_SITE_API, subpath)


def _current_nhl_season():
    """NHL seasonIds span two years (20252026). The regular season opens in October, so
    September onward belongs to the season starting that year."""
    now = datetime.utcnow()
    start = now.year if now.month >= 9 else now.year - 1
    return str(start) + str(start + 1)


def _nhl_report_rows(report, season):
    """One league-wide NHL stats report for a season (all 32 teams in one call), cached."""
    cache_key = 'nhl:' + report + ':' + season
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached['fetched_at']) < CACHE_TTL:
        return cached['data']
    r = _nhl_get_with_retry(NHL_STATS_API + '/' + report, params={'cayenneExp': 'seasonId=' + season + ' and gameTypeId=2'})
    rows = r.json().get('data') or []
    _cache[cache_key] = {'data': rows, 'fetched_at': time.time()}
    return rows


def _norm_team_name(name):
    # ESPN says "Montreal Canadiens", the NHL API says "Montréal Canadiens".
    return unicodedata.normalize('NFKD', name or '').encode('ascii', 'ignore').decode().lower().strip()


def _compute_nhl_team_summary(team_name, season):
    """The 7 team-level terms of the hockey composite (home ice and back-to-back are matchup
    context, set on the page). Only 3 league-wide calls, shared across every team via cache."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        summary_f = ex.submit(_nhl_report_rows, 'summary', season)
        pct_f = ex.submit(_nhl_report_rows, 'percentages', season)
        pen_f = ex.submit(_nhl_report_rows, 'penalties', season)
        summary, pct, pen = summary_f.result(), pct_f.result(), pen_f.result()

    target = _norm_team_name(team_name)

    def find(rows):
        return next((r for r in rows if _norm_team_name(r.get('teamFullName')) == target), None)

    s, p, n = find(summary), find(pct), find(pen)
    if not s or not s.get('gamesPlayed'):
        return None
    gp = s['gamesPlayed']
    p, n = p or {}, n or {}
    drawn, taken = n.get('penaltiesDrawnPer60'), n.get('penaltiesTakenPer60')
    return {
        'team': s.get('teamFullName'),
        'season': season,
        'gamesPlayed': gp,
        'corsiPct': p.get('satPct'),
        'goalDiffPerGame': ((s.get('goalsFor') or 0) - (s.get('goalsAgainst') or 0)) / gp,
        'winPct': (s.get('wins') or 0) / gp,
        'zoneStartPct': p.get('zoneStartPct5v5'),
        'powerPlayPct': s.get('powerPlayPct'),
        'netPenaltiesPer60': (drawn - taken) if drawn is not None and taken is not None else None,
        'faceoffPct': s.get('faceoffWinPct'),
    }


# ESPN abbreviations that differ from the NHL's own (everything else matches).
ESPN_TO_NHL_TEAM = {'LA': 'LAK', 'NJ': 'NJD', 'SJ': 'SJS', 'TB': 'TBL', 'UTAH': 'UTA'}
NHL_INACTIVE_STATUSES = {'out', 'injured reserve', 'long-term injured reserve', 'ltir', 'ir', 'suspension', 'suspended'}
MIN_GP_FOR_CURRENT_TOI = 5  # fewer games than this this season -> rank by last season's ice time instead


def _nhl_get_with_retry(url, params=None, timeout=REQUEST_TIMEOUT):
    """The NHL's APIs rate-limit bursts with 429s -- back off and retry a few times rather
    than failing the whole page."""
    delay = 1.0
    for attempt in range(4):
        r = requests.get(url, params=params, timeout=timeout)
        if r.status_code != 429 or attempt == 3:
            r.raise_for_status()
            return r
        time.sleep(float(r.headers.get('Retry-After') or delay))
        delay *= 2


def _nhl_web_get(path):
    cache_key = 'nhlweb:' + path
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached['fetched_at']) < CACHE_TTL:
        return cached['data']
    data = _nhl_get_with_retry(NHL_WEB_API + '/' + path).json()
    _cache[cache_key] = {'data': data, 'fetched_at': time.time()}
    return data


def _player_name(p):
    return ((p.get('firstName') or {}).get('default', '') + ' ' + (p.get('lastName') or {}).get('default', '')).strip()


def _espn_team_injuries(espn_abbrev):
    """normalized player name -> {status, detail}. Pulled from the team's own ESPN roster
    (carries IR/suspension designations) with the league-wide injuries feed layered under it
    for day-to-day notes -- same roster-wins merge as the football page."""
    out = {}
    roster = requests.get(ESPN_NHL_SITE_API + '/teams/' + espn_abbrev.lower() + '/roster', timeout=REQUEST_TIMEOUT).json()
    team_id = str((roster.get('team') or {}).get('id'))
    try:
        feed = requests.get(ESPN_NHL_SITE_API + '/injuries', timeout=REQUEST_TIMEOUT).json()
        for team_group in feed.get('injuries') or []:
            if str(team_group.get('id')) != team_id:  # names aren't unique league-wide (two Sebastian Ahos)
                continue
            for inj in team_group.get('injuries') or []:
                name = (inj.get('athlete') or {}).get('displayName')
                if name:
                    out[_norm_team_name(name)] = {'status': inj.get('status') or 'Injured', 'detail': inj.get('shortComment')}
    except (requests.RequestException, ValueError):
        pass
    for group in roster.get('athletes') or []:
        for p in group.get('items') or []:
            injuries = p.get('injuries') or []
            if injuries:
                latest = sorted(injuries, key=lambda i: i.get('date') or '', reverse=True)[0]
                key = _norm_team_name(p.get('displayName'))
                out[key] = {'status': latest.get('status') or 'Injured', 'detail': (out.get(key) or {}).get('detail')}
    return out


def _compute_nhl_lineup(espn_abbrev):
    """Estimated lineup ranked by average ice time -- the NHL publishes no official line
    combinations, and ESPN's hockey depth-chart endpoint is empty. Injured regulars keep the
    slot their ice time earned them (struck through on the page) instead of quietly being
    replaced by whoever is filling in."""
    abbrev = ESPN_TO_NHL_TEAM.get(espn_abbrev.upper(), espn_abbrev.upper())
    current = _current_nhl_season()
    prior = str(int(current[:4]) - 1) + current[:4]

    def club_stats(season):
        try:
            return _nhl_web_get('club-stats/' + abbrev + '/' + season + '/2')
        except requests.RequestException:
            return {'skaters': [], 'goalies': []}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        roster_f = ex.submit(_nhl_web_get, 'roster/' + abbrev + '/current')
        cur_f, prior_f = ex.submit(club_stats, current), ex.submit(club_stats, prior)
        inj_f = ex.submit(_espn_team_injuries, espn_abbrev)
        roster, cur, prev = roster_f.result(), cur_f.result(), prior_f.result()
        try:
            injuries = inj_f.result()
        except (requests.RequestException, ValueError):
            injuries = {}

    cur_sk = {s['playerId']: s for s in cur.get('skaters') or []}
    prev_sk = {s['playerId']: s for s in prev.get('skaters') or []}
    cur_g = {g['playerId']: g for g in cur.get('goalies') or []}
    prev_g = {g['playerId']: g for g in prev.get('goalies') or []}

    players = {}  # playerId -> {name, pos}
    for group, default_pos in (('forwards', 'F'), ('defensemen', 'D'), ('goalies', 'G')):
        for p in roster.get(group) or []:
            players[p['id']] = {'name': _player_name(p), 'pos': p.get('positionCode') or default_pos}
    # Players on IR fall off the NHL's "current" roster -- add back anyone who's logged time
    # for this team and is on the injury list, so an injured regular keeps his spot.
    for pool, is_goalie in ((cur_sk, False), (prev_sk, False), (cur_g, True), (prev_g, True)):
        for pid, s in pool.items():
            name = _player_name(s)
            if pid not in players and _norm_team_name(name) in injuries:
                players[pid] = {'name': name, 'pos': 'G' if is_goalie else s.get('positionCode') or 'F'}

    def tag(p):
        inj = injuries.get(_norm_team_name(p['name']))
        p['injury'] = inj['status'] if inj else None
        p['injuryDetail'] = inj['detail'] if inj else None
        p['inactive'] = bool(inj) and inj['status'].lower() in NHL_INACTIVE_STATUSES
        return p

    def skater_toi(pid):
        s = cur_sk.get(pid)
        if s and s.get('gamesPlayed', 0) >= MIN_GP_FOR_CURRENT_TOI:
            return s.get('avgTimeOnIcePerGame') or 0
        s = prev_sk.get(pid) or s
        return (s or {}).get('avgTimeOnIcePerGame') or 0

    def goalie_starts(pid):
        g = cur_g.get(pid)
        if g and g.get('gamesPlayed', 0) >= MIN_GP_FOR_CURRENT_TOI:
            return g.get('gamesStarted') or 0
        return ((prev_g.get(pid) or g) or {}).get('gamesStarted') or 0

    def last_nhl_season_rows(pid):
        """Newcomers have no history with THIS team yet -- fall back to their most recent NHL
        regular season with any team (all rows of it, in case they were traded mid-season)."""
        try:
            totals = _nhl_web_get('player/' + str(pid) + '/landing').get('seasonTotals') or []
        except requests.RequestException:
            return []
        nhl = [s for s in totals if s.get('leagueAbbrev') == 'NHL' and s.get('gameTypeId') == 2]
        if not nhl:
            return []
        last = max(s['season'] for s in nhl)
        return [s for s in nhl if s['season'] == last]

    def career_toi(pid):
        rows = [r for r in last_nhl_season_rows(pid) if r.get('avgToi')]
        secs = lambda t: int(t.split(':')[0]) * 60 + int(t.split(':')[1])
        gp = sum(r.get('gamesPlayed') or 0 for r in rows)
        return sum(secs(r['avgToi']) * (r.get('gamesPlayed') or 0) for r in rows) / gp if gp else 0

    def career_starts(pid):
        return sum(r.get('gamesStarted') or 0 for r in last_nhl_season_rows(pid))

    skater_ids = [pid for pid, p in players.items() if p['pos'] != 'G']
    toi = {pid: skater_toi(pid) for pid in skater_ids}
    newcomers = [pid for pid in skater_ids if not toi[pid]]
    if newcomers:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            for pid, t in zip(newcomers, ex.map(career_toi, newcomers)):
                toi[pid] = t

    skaters = [tag(dict(players[pid], id=pid, toi=round(toi[pid] / 60, 1))) for pid in skater_ids]
    skaters.sort(key=lambda p: -p['toi'])
    forwards = [p for p in skaters if p['pos'] in ('C', 'L', 'R', 'F')]
    defense = [p for p in skaters if p['pos'] == 'D']

    # Top 12 forwards by ice time, 3 per line in rank order (so line 1 really is the 3 most-used
    # forwards). Within each trio, natural C / LW / RW take their own slot first and anyone left
    # fills the open one(s) -- plenty of centers play wing.
    top12, lines = forwards[:12], []
    for i in range(0, len(top12), 3):
        trio, line = list(top12[i:i + 3]), {}
        for slot, code in (('C', 'C'), ('LW', 'L'), ('RW', 'R')):
            pick = next((p for p in trio if p['pos'] == code), None)
            if pick:
                line[slot] = pick
                trio.remove(pick)
        for slot in ('C', 'LW', 'RW'):
            if slot not in line and trio:
                line[slot] = trio.pop(0)
        lines.append(line)

    goalie_ids = [pid for pid, p in players.items() if p['pos'] == 'G']
    starts = {pid: goalie_starts(pid) for pid in goalie_ids}
    for pid in goalie_ids:
        if not starts[pid]:
            starts[pid] = career_starts(pid)
    goalies = [tag(dict(players[pid], id=pid, starts=starts[pid], **_goalie_save_pct(pid, current, prior)))
               for pid in goalie_ids]
    goalies.sort(key=lambda g: -g['starts'])

    injury_adjust = _lineup_injury_adjustment(forwards, defense, current, prior)

    return {
        'team': abbrev,
        'injuryAdjust': injury_adjust,
        'forwardLines': lines,
        'defensePairs': [defense[i:i + 2] for i in range(0, min(len(defense), 6), 2)],
        'goalies': goalies[:2],
        'goalieOptions': goalies,  # every goalie on the roster, for the page's starting-goalie picker
        'extras': [p for p in forwards if p not in top12] + defense[6:],
        'seasonNote': 'ranked by ' + current[:4] + '-' + current[6:] + ' ice time once a player has '
                      + str(MIN_GP_FOR_CURRENT_TOI) + '+ games, else ' + prior[:4] + '-' + prior[6:],
    }


GOALIE_SHRINK_SHOTS = 500  # phantom league-average shots; best of 500/1000/2000 in nhl_goalie_test.py


def _league_save_pct(season):
    cache_key = 'nhlleaguesv:' + season
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached['fetched_at']) < CACHE_TTL:
        return cached['data']
    rows = _nhl_get_with_retry('https://api.nhle.com/stats/rest/en/goalie/summary',
                               params={'cayenneExp': 'seasonId=' + season + ' and gameTypeId=2', 'limit': -1},
                               timeout=30).json().get('data') or []
    shots = sum(r.get('shotsAgainst') or 0 for r in rows)
    sv = sum(r.get('saves') or 0 for r in rows) / shots if shots else 0.905
    _cache[cache_key] = {'data': sv, 'fetched_at': time.time()}
    return sv


def _goalie_save_pct(pid, current, prior):
    """Save % going into tonight, exactly as backtested: this season + last season with any
    team, shrunk toward last season's league average by GOALIE_SHRINK_SHOTS phantom shots so a
    goalie with a handful of starts doesn't swing the model."""
    try:
        totals = _nhl_web_get('player/' + str(pid) + '/landing').get('seasonTotals') or []
        league = _league_save_pct(prior)
    except requests.RequestException:
        return {'savePct': None, 'rawSavePct': None, 'shots': 0}
    rows = [t for t in totals if t.get('leagueAbbrev') == 'NHL' and t.get('gameTypeId') == 2
            and str(t.get('season')) in (current, prior)]
    shots = sum(t.get('shotsAgainst') or 0 for t in rows)
    saves = shots - sum(t.get('goalsAgainst') or 0 for t in rows)
    return {
        'savePct': (saves + league * GOALIE_SHRINK_SHOTS) / (shots + GOALIE_SHRINK_SHOTS),
        'rawSavePct': saves / shots if shots else None,
        'shots': shots,
    }


def _nhl_skater_report(report, season):
    """League-wide per-player report for one season (one row per player, trades merged), cached."""
    cache_key = 'nhlskater:' + report + ':' + season
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached['fetched_at']) < CACHE_TTL:
        return cached['data']
    r = _nhl_get_with_retry('https://api.nhle.com/stats/rest/en/skater/' + report,
                            params={'cayenneExp': 'seasonId=' + season + ' and gameTypeId=2', 'limit': -1},
                            timeout=30)
    rows = {row['playerId']: row for row in r.json().get('data') or []}
    _cache[cache_key] = {'data': rows, 'fetched_at': time.time()}
    return rows


def _lineup_injury_adjustment(forwards, defense, current, prior):
    """How much tonight's injuries move the team's Corsi % and faceoff %.

    Full strength = the top 12 forwards + top 6 D by ice time, injured included. Tonight = the
    same with players who are out removed, so healthy depth moves up. Corsi uses each skater's
    Corsi RELATIVE (on-ice minus off-ice) weighted by 5v5 ice time -- raw on-ice Corsi mostly
    reflects the team, so a star and his replacement look nearly identical on it. Faceoffs are
    pooled per game. Zone starts are deliberately not adjusted: a player's zone start % is how
    the coach deploys him, not how good he is.

    Returned as deltas (tonight minus full strength, fractions) applied on top of the team's
    own season numbers, which keeps the model's team-level calibration intact."""
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            pct = {s: ex.submit(_nhl_skater_report, 'percentages', s) for s in (current, prior)}
            fo = {s: ex.submit(_nhl_skater_report, 'faceoffwins', s) for s in (current, prior)}
            pct = {s: f.result() for s, f in pct.items()}
            fo = {s: f.result() for s, f in fo.items()}
    except requests.RequestException:
        return None

    def row(report, pid):
        cur = report[current].get(pid)
        if cur and cur.get('gamesPlayed', 0) >= MIN_GP_FOR_CURRENT_TOI:
            return cur
        return report[prior].get(pid) or cur

    def lineup(healthy_only):
        pool_f = [p for p in forwards if not (healthy_only and p['inactive'])][:12]
        pool_d = [p for p in defense if not (healthy_only and p['inactive'])][:6]
        return pool_f + pool_d

    def rates(players):
        w = rel = fo_w = fo_t = 0.0
        for p in players:
            r = row(pct, p['id'])
            if r and r.get('timeOnIcePerGame5v5') and r.get('satRelative') is not None:
                w += r['timeOnIcePerGame5v5']
                rel += r['timeOnIcePerGame5v5'] * r['satRelative']
            # No NHL history (call-up / rookie) -> counts as a replacement-level 0 relative.
            elif p['toi']:
                w += p['toi'] * 60 * 0.8
            f = row(fo, p['id'])
            if f and f.get('gamesPlayed'):
                fo_w += (f.get('totalFaceoffWins') or 0) / f['gamesPlayed']
                fo_t += (f.get('totalFaceoffs') or 0) / f['gamesPlayed']
        return (rel / w if w else None, fo_w / fo_t if fo_t else None)

    full, tonight = lineup(False), lineup(True)
    out_players = [p['name'] for p in full if p['inactive']]
    if not out_players:
        return {'corsi': 0, 'faceoff': 0, 'out': [], 'replacements': []}
    a, b = rates(full), rates(tonight)
    delta = lambda i: (b[i] - a[i]) if a[i] is not None and b[i] is not None else 0
    return {
        'corsi': delta(0), 'faceoff': delta(1),
        'out': out_players,
        'replacements': [p['name'] for p in tonight if p not in full],
    }


@app.route('/api/nhl/lineup/<espn_abbrev>')
def nhl_lineup(espn_abbrev):
    try:
        return jsonify(_compute_nhl_lineup(espn_abbrev))
    except requests.RequestException as e:
        return jsonify({'error': 'NHL lineup request failed: ' + str(e)}), 502


# Early in a season a team's stats are a handful of games of noise (one game in, a team can show
# 62% Corsi and a 0.000 win %). Blending in last season as if it were this many games of this
# season fixed that in the backtest: games 3-10 went from 55.5% to 58.0% correct, log loss
# 0.689 -> 0.673, with no cost later in the year (nhl_game_features_*.csv, K in 0..40 tested).
NHL_PRIOR_SEASON_GAMES = 15
NHL_BLEND_KEYS = ('corsiPct', 'goalDiffPerGame', 'winPct', 'zoneStartPct', 'powerPlayPct', 'netPenaltiesPer60', 'faceoffPct')


@app.route('/api/nhl/team-summary/<path:team_name>')
def nhl_team_summary(team_name):
    """Current NHL season blended with last season (see NHL_PRIOR_SEASON_GAMES); falls back to
    last season alone if the current one has no games yet. ?season= returns that season raw."""
    season_param = request.args.get('season')
    current = _current_nhl_season()
    prior = str(int(current[:4]) - 1) + current[:4]
    try:
        if season_param:
            result = _compute_nhl_team_summary(team_name, season_param)
        else:
            cur = _compute_nhl_team_summary(team_name, current)
            prev = _compute_nhl_team_summary(team_name, prior)
            result = cur or prev
            if cur and prev:
                gp, k = cur['gamesPlayed'], NHL_PRIOR_SEASON_GAMES
                for key in NHL_BLEND_KEYS:
                    if cur.get(key) is not None and prev.get(key) is not None:
                        result[key] = (gp * cur[key] + k * prev[key]) / (gp + k)
                result['blendedWithSeason'] = prior
                result['priorSeasonWeight'] = k / (gp + k)
    except requests.RequestException as e:
        return jsonify({'error': 'NHL stats request failed: ' + str(e)}), 502
    if result:
        return jsonify(result)
    return jsonify({'error': 'No games found for ' + team_name + ' in ' + (season_param or current + ' or ' + prior)}), 404


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    # threaded=True matters here -- fetching a full matchup fires dozens of concurrent
    # proxied requests (one per player being rated), and the default single-threaded dev
    # server would queue them one at a time, making the page look like it's hung.
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
