"""
Kalshi Value Models -- server.

Serves the static frontend (index.html, value_model.html, football.html) AND
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


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    # threaded=True matters here -- fetching a full matchup fires dozens of concurrent
    # proxied requests (one per player being rated), and the default single-threaded dev
    # server would queue them one at a time, making the page look like it's hung.
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
