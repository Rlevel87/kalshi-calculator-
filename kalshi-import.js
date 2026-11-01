/* =======================================================================
   Import Kalshi's realized P&L export (Kalshi -> Account -> download
   realized P&L, a .csv inside a .zip -- unzip it first) into a page's trade
   log, so P/L uses Kalshi's actual fills, contract counts and fees instead
   of the estimates from logging by hand.

   Shared by every sport page. Each page calls
   importKalshiPnlCsv(event, ['KXNHLGAME']) with the market series it
   covers, and must define loadLog / saveLog / renderLog (they all do).

   - One trade-log entry per row of the export. Re-importing the same file
     (or a newer one covering the same dates) never duplicates: each row is
     keyed by ticker + side + open time.
   - Trades you logged by hand inside the export's date range can be
     replaced by Kalshi's versions (you're asked first). When one matches
     -- same date, price within 2c -- its model % and edge carry over, so
     the log still shows what the model said.
   ======================================================================= */

/* ---------------------------- average price panel (trade log) ----------------------------
   Betting every model pick wins money only if win rate > average (price + Kalshi fee). This shows
   both side by side for the last 7 days, last 30 days and all time, from SETTLED trades only.
   Each page's renderLog() calls renderAveragePricePanel(entries); the page needs a
   <div id="logPriceSummary"> under its log summary line. Display only -- not a model input. */
function renderAveragePricePanel(entries) {
  const el = document.getElementById('logPriceSummary');
  if (!el) return;
  const settled = entries.filter(function (e) {
    return e.result === 'win' || e.result === 'loss' || (e.result === 'cashout' && e.cashOutAmount != null && !isNaN(e.cashOutAmount));
  });
  if (!settled.length) { el.innerHTML = ''; return; }
  const iso = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const daysAgo = function (n) { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
  const windows = [['Last 7 days', daysAgo(7)], ['Last 30 days', daysAgo(30)], ['All time', '']];
  const rows = windows.map(function (w) {
    const set = settled.filter(function (e) { return e.date >= w[1]; });
    if (!set.length) return '<tr><td>' + w[0] + '</td><td style="text-align:right">0</td><td style="text-align:right">—</td><td style="text-align:right">—</td><td style="text-align:right">—</td><td style="text-align:right">—</td></tr>';
    // A cash-out counts as a win if it made money (same rule as the summary line's win rate).
    const wins = set.filter(function (e) {
      return e.result === 'win' || (e.result === 'cashout' && e.cashOutAmount - e.stakeDollars > 0);
    }).length;
    const winRate = wins / set.length;
    const avgPrice = set.reduce(function (t, e) { return t + e.price; }, 0) / set.length;
    const breakEven = set.reduce(function (t, e) { return t + e.price + 0.07 * e.price * (1 - e.price); }, 0) / set.length;
    const margin = (winRate - breakEven) * 100;
    const color = margin >= 2 ? 'var(--pos)' : (margin < 0 ? 'var(--neg)' : 'var(--neutral)');
    return '<tr><td>' + w[0] + '</td><td style="text-align:right">' + set.length + '</td><td style="text-align:right">' + (winRate * 100).toFixed(1) + '%</td>' +
      '<td style="text-align:right"><strong>' + (avgPrice * 100).toFixed(1) + '¢</strong></td><td style="text-align:right">' + (breakEven * 100).toFixed(1) + '%</td>' +
      '<td style="text-align:right;color:' + color + ';font-weight:700;">' + (margin >= 0 ? '+' : '') + margin.toFixed(1) + ' pts</td></tr>';
  }).join('');
  el.innerHTML = '<table class="log-table" style="margin-top:10px;max-width:640px;" title="Margin = win rate minus break-even (average price + Kalshi fee). Green = 2+ pts, gold = 0-2, red = below break-even.">' +
    '<thead><tr><th>Settled trades</th><th style="text-align:right">Bets</th><th style="text-align:right">Won</th><th style="text-align:right">Avg price</th><th style="text-align:right">Break-even</th><th style="text-align:right">Margin</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

/* ---------------------------- win rate needed (Matchup Data) ----------------------------
   For recorded matchups that have settled: how often the model's predicted winner won, versus the
   win rate it would NEED to profit betting every pick at the recorded prices (average price of the
   picked side + Kalshi's fee). Also appends the same "needed" number to the existing
   Recommendation win rate. Each page's renderRecommendationPerf() calls this; tiles are optional
   (skipped if a page doesn't have the elements). Uses the raw Kalshi price when the record has it,
   else the de-vigged market price. */
function renderNeededWinRates(entries) {
  const settled = entries.filter(function (e) {
    return (e.result === 'A' || e.result === 'B') && e.modelA != null && e.modelB != null && e.marketA != null && e.marketB != null;
  });
  const priceOf = function (e, side) {
    const raw = side === 'A' ? e.rawA : e.rawB;
    return (raw != null && !isNaN(raw)) ? raw : (side === 'A' ? e.marketA : e.marketB);
  };
  const breakEven = function (p) { return p + 0.07 * p * (1 - p); };
  const set = function (id, text, color) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (color !== undefined) el.style.color = color;
  };
  const marginColor = function (m) { return m >= 2 ? 'var(--pos)' : (m < 0 ? 'var(--neg)' : 'var(--neutral)'); };

  // Every model pick (the side the model gave > 50%).
  if (!settled.length) {
    set('pickWinRateVal', '—', ''); set('pickWinRateSub', '0 settled picks');
    set('neededWinRateVal', '—', ''); set('neededWinRateSub', 'avg price + Kalshi fee');
  } else {
    let wins = 0, priceSum = 0, beSum = 0;
    settled.forEach(function (e) {
      const side = e.modelA >= e.modelB ? 'A' : 'B';
      const p = priceOf(e, side);
      if (side === e.result) wins++;
      priceSum += p; beSum += breakEven(p);
    });
    const n = settled.length, wr = 100 * wins / n, need = 100 * beSum / n, margin = wr - need;
    set('pickWinRateVal', wr.toFixed(1) + '%', marginColor(margin));
    set('pickWinRateSub', n + ' settled pick' + (n === 1 ? '' : 's') + ' · ' + (margin >= 0 ? '+' : '') + margin.toFixed(1) + ' pts vs. needed');
    set('neededWinRateVal', need.toFixed(1) + '%');
    set('neededWinRateSub', 'avg pick price ' + (100 * priceSum / n).toFixed(1) + '¢ + Kalshi fee');
  }

  // Recommendations (the value side) -- append what they'd need to the existing tile.
  const recs = settled.filter(function (e) { return e.recSide === 'A' || e.recSide === 'B'; });
  const sub = document.getElementById('recWinRateSub');
  if (sub && recs.length) {
    const need = 100 * recs.reduce(function (t, e) { return t + breakEven(priceOf(e, e.recSide)); }, 0) / recs.length;
    sub.textContent = sub.textContent.split(' · needs')[0] + ' · needs ' + need.toFixed(1) + '% to profit';
  }
}

function parseKalshiCsv(text) {
  const lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
  if (!lines.length) return [];
  const header = lines[0].split(',').map(function (h) { return h.trim(); });
  return lines.slice(1).map(function (line) {
    const cells = line.split(',');
    const row = {};
    header.forEach(function (h, i) { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

// "KXMLBGAME-26JUL241845AZWSH-AZ" -> { matchup: 'AZ vs WSH', side: 'AZ' }. Team codes run together
// after the date/time, so the other team is whatever's left once the side's code is removed.
function kalshiTickerTeams(ticker) {
  const parts = ticker.split('-');
  const side = parts[parts.length - 1] || '';
  const m = /^\d{2}[A-Z]{3}\d{2}(?:\d{4})?(.*)$/.exec(parts[1] || '');
  const teams = m ? m[1] : '';
  let first = teams, second = '';
  if (side && teams.indexOf(side) === 0) { first = side; second = teams.slice(side.length); }
  else if (side && teams.slice(-side.length) === side) { first = teams.slice(0, -side.length); second = side; }
  return { matchup: second ? first + ' vs ' + second : (teams || ticker), side: side || ticker };
}

function kalshiRowToEntry(row) {
  const qty = parseFloat(row.quantity_fp), entry = parseFloat(row.entry_price_dollars), exit = parseFloat(row.exit_price_dollars);
  const fees = (parseFloat(row.open_fees_dollars) || 0) + (parseFloat(row.close_fees_dollars) || 0);
  const opened = new Date(row.open_timestamp);
  const local = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const teams = kalshiTickerTeams(row.market_ticker);
  // A "no" contract pays out if the named side does NOT happen -- say so in the side column.
  const side = row.side === 'no' ? 'NO on ' + teams.side : teams.side;
  const e = {
    id: opened.getTime() + Math.round(qty * 1000 + entry * 100),
    kalshiKey: row.market_ticker + '|' + row.side + '|' + row.open_timestamp + '|' + row.quantity_fp + '|' + row.exit_price_dollars,
    source: 'kalshi', ticker: row.market_ticker,
    date: local(opened), matchup: teams.matchup, side: side,
    price: entry, contracts: qty, stakeDollars: qty * entry, fee: fees,
    model: null, edge: null,
    kalshiNetPL: parseFloat(row.realized_pnl_with_fees_dollars)
  };
  if (exit >= 0.999) e.result = 'win';
  else if (exit <= 0.001) e.result = 'loss';
  else { e.result = 'cashout'; e.cashOutAmount = qty * exit; } // sold before settlement
  return e;
}

function importKalshiPnlCsv(event, seriesPrefixes) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const rows = parseKalshiCsv(reader.result);
      if (!rows.length || !('market_ticker' in rows[0]) || !('realized_pnl_with_fees_dollars' in rows[0])) {
        throw new Error('not a Kalshi realized P&L export');
      }
      const mine = rows.filter(function (r) {
        return seriesPrefixes.some(function (p) { return r.market_ticker.indexOf(p + '-') === 0; });
      });
      if (!mine.length) {
        alert('That file has ' + rows.length + ' trades, but none in this page\'s markets (' + seriesPrefixes.join(', ') + ').');
        return;
      }
      const imported = mine.map(kalshiRowToEntry);
      const dates = imported.map(function (e) { return e.date; }).sort();
      const first = dates[0], last = dates[dates.length - 1];

      let log = loadLog();
      const have = new Set(log.filter(function (e) { return e.kalshiKey; }).map(function (e) { return e.kalshiKey; }));
      const fresh = imported.filter(function (e) { return !have.has(e.kalshiKey); });

      // Hand-logged trades in the same date range: carry their model % / edge over to the matching
      // Kalshi fill, then (if confirmed) drop them so nothing is counted twice.
      const manual = log.filter(function (e) { return !e.kalshiKey && e.date >= first && e.date <= last; });
      const used = new Set();
      fresh.forEach(function (k) {
        const match = manual.find(function (m) {
          return !used.has(m) && m.date === k.date && Math.abs(m.price - k.price) <= 0.02 && m.model !== null && m.model !== undefined;
        });
        if (match) { used.add(match); k.model = match.model; k.edge = match.model - k.price; k.loggedSide = match.side; }
      });
      let replaced = 0;
      if (manual.length && confirm(
        'You have ' + manual.length + ' hand-logged trade' + (manual.length === 1 ? '' : 's') + ' between ' + first + ' and ' + last +
        '. Replace ' + (manual.length === 1 ? 'it' : 'them') + ' with Kalshi\'s actual fills so nothing is counted twice?\n\n' +
        'Model % carries over to ' + used.size + ' matching fill' + (used.size === 1 ? '' : 's') + '. Cancel keeps both.')) {
        const drop = new Set(manual);
        log = log.filter(function (e) { return !drop.has(e); });
        replaced = manual.length;
      }
      log = log.concat(fresh).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; });
      saveLog(log);
      renderLog();
      const net = imported.reduce(function (t, e) { return t + (isNaN(e.kalshiNetPL) ? 0 : e.kalshiNetPL); }, 0);
      alert('Imported ' + fresh.length + ' new Kalshi fill' + (fresh.length === 1 ? '' : 's') +
        (imported.length - fresh.length ? ' (' + (imported.length - fresh.length) + ' already in the log)' : '') +
        (replaced ? ', replaced ' + replaced + ' hand-logged trade' + (replaced === 1 ? '' : 's') : '') +
        '.\nKalshi\'s realized P/L for these ' + imported.length + ' (' + first + ' to ' + last + '): ' +
        (net >= 0 ? '+$' : '-$') + Math.abs(net).toFixed(2) + ' after fees.');
    } catch (err) {
      alert('Could not read that file as a Kalshi realized P&L export (.csv). If you downloaded a .zip, unzip it first.');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}
