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
import time
from datetime import datetime
from flask import Flask, request, jsonify, Response, send_from_directory
import requests

app = Flask(__name__, static_folder='.', static_url_path='')

ESPN_SITE_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl'
ESPN_WEB_API = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl'
ESPN_CORE_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl'

NFLVERSE_STATS_TEAM = 'https://github.com/nflverse/nflverse-data/releases/download/stats_team'
NFLVERSE_SCHEDULES = 'https://github.com/nflverse/nflverse-data/releases/download/schedules'

REQUEST_TIMEOUT = 15
CACHE_TTL = 3600  # seconds -- nflverse data updates at most ~weekly during the season


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
