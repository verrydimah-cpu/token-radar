// Token Radar's page. Reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// ranked board, its filters, and a dossier-style detail view per protocol. No network, no fetch:
// every byte it shows arrived in data.js, and every figure traces to the sealed snapshot.
(function () {
  'use strict';

  var R = window.RADAR;
  if (!R || !R.rows) return;
  var rows = R.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });
  var maxValue = rows.length ? rows[0].implied_value_usd : 1;
  var maxTvl = rows.reduce(function (m, r) { return Math.max(m, r.tvl_usd); }, 0);

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n) {
    if (n === null || n === undefined) return '<span class="flat">—</span>';
    var cls = n > 0.05 ? 'pos' : n < -0.05 ? 'neg' : 'flat';
    return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }
  function fmtAge(y) {
    if (y === null || y === undefined) return '<span class="agechip">age n/a</span>';
    var old = y >= 3 ? ' old' : '';
    return '<span class="agechip' + old + '">' + y.toFixed(1) + 'y tokenless</span>';
  }
  function rkClass(rank) { return rank <= 3 ? ' rk-' + rank : ''; }
  function basisText(r) {
    if (r.ratio_basis === 'category') return esc(r.category) + ' median · ' + r.ratio_comps + ' traded comparables';
    if (r.ratio_basis === 'shrunk') return esc(r.category) + ' has ' + r.ratio_comps + ' traded comparable' + (r.ratio_comps === 1 ? '' : 's') + ' — its median shrunk toward the global ' + R.ratios.global.toFixed(3);
    return 'no traded comparable in its category — the global median of ' + R.ratios.global_comps + ' traded protocols';
  }
  function catRow(r) {
    for (var i = 0; i < R.ratios.categories.length; i++) {
      if (R.ratios.categories[i].category === r.category) return R.ratios.categories[i];
    }
    return null;
  }
  function confLabel(c) {
    return c === 'strong' ? 'Strong comp base' : c === 'moderate' ? 'Moderate comp base' : 'Thin comp base';
  }
  function compPanel(r) {
    var c = catRow(r);
    var g = R.ratios;
    var line, note;
    if (r.ratio_basis === 'global' || !c) {
      line = 'No traded protocol in ' + (r.category ? esc(r.category) : 'its category') + ' to compare against.';
      note = 'Valued on the global median ' + g.global.toFixed(3) + '× across ' + g.global_comps +
        ' traded protocols — the largest include ' + esc(g.global_names.join(', ')) + '.';
    } else if (r.ratio_basis === 'shrunk') {
      line = esc(r.category) + ' has only ' + c.comps + ' traded comparable' + (c.comps === 1 ? '' : 's') +
        ' — ' + esc(c.names.join(', ')) + ' — too few to trust on their own.';
      note = 'Their median ' + c.median.toFixed(3) + '× is shrunk toward the global median ' + g.global.toFixed(3) +
        '× (' + g.global_comps + ' traded protocols), giving the ' + c.used.toFixed(3) + '× used above.';
    } else {
      line = 'The ' + esc(r.category) + ' ratio rests on ' + c.comps + ' traded comparables — largest: ' +
        esc(c.names.join(', ')) + '.';
      note = 'Category median ' + c.median.toFixed(3) + '×, used as it stands; the global median across ' +
        g.global_comps + ' traded protocols is ' + g.global.toFixed(3) + '×.';
    }
    var verdict = r.confidence === 'strong' ? 'A deep traded set carries this ratio.'
      : r.confidence === 'moderate' ? 'A workable base — read the value as a range, not a point.'
      : 'A thin base — treat this value as the roughest kind of claim.';
    return '<div class="comp-panel"><div class="comp-head"><h4>The comparable set behind this number</h4>' +
      '<span class="conf conf-' + r.confidence + '">' + confLabel(r.confidence) + '</span></div>' +
      '<p class="comp-line">' + line + '</p><p class="comp-note">' + note + ' ' + verdict + '</p></div>';
  }

  // ---------- masthead, ratios, live strip ----------
  document.getElementById('mver').textContent = R.model_version;
  document.getElementById('st-asof').textContent = R.as_of;
  document.getElementById('st-scanned').textContent = R.stats.protocols;
  document.getElementById('st-board').textContent = R.stats.board_rows;
  document.getElementById('st-watch').textContent = R.stats.watchlist;
  document.getElementById('ft-source').textContent = R.source;

  var rt = '<table><thead><tr><th>Category</th><th class="n">Traded comps</th><th class="n">Median</th><th class="n">Ratio used</th><th>Basis</th></tr></thead><tbody>';
  R.ratios.categories.forEach(function (c) {
    rt += '<tr><td>' + esc(c.category) + '</td><td class="n">' + c.comps + '</td><td class="n">' + c.median.toFixed(3) +
      '</td><td class="n">' + c.used.toFixed(3) + '</td><td>' + c.basis + '</td></tr>';
  });
  rt += '<tr><td>All traded protocols</td><td class="n">' + R.ratios.global_comps + '</td><td class="n">' + R.ratios.global.toFixed(3) +
    '</td><td class="n">' + R.ratios.global.toFixed(3) + '</td><td>global</td></tr></tbody></table>';
  document.getElementById('ratio-table').innerHTML = rt;

  document.getElementById('live-chips').innerHTML = R.live.map(function (p) {
    return '<span class="lchip"><b>' + esc(p.name) + '</b> · ' + fmtUsd(p.mcap_usd) + '</span>';
  }).join('');

  // ---------- highlights strip: board stats + top movers ----------
  var byValue = rows.slice().sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd; });
  var mid = Math.floor(byValue.length / 2);
  var medianValue = byValue.length % 2 === 1 ? byValue[mid].implied_value_usd
    : (byValue[mid - 1].implied_value_usd + byValue[mid].implied_value_usd) / 2;
  var boardTvl = rows.reduce(function (sum, r) { return sum + r.tvl_usd; }, 0);
  document.getElementById('ss-median').textContent = fmtUsd(medianValue);
  document.getElementById('ss-tvl').textContent = fmtUsd(boardTvl);
  document.getElementById('ss-watch').textContent = R.stats.watchlist + ' of ' + R.stats.board_rows +
    ' · ' + Math.round((R.stats.watchlist / R.stats.board_rows) * 100) + '%';
  var movers = rows.filter(function (r) { return r.change_7d !== null; })
    .sort(function (a, b) { return b.change_7d - a.change_7d || a.rank - b.rank; })
    .slice(0, 5);
  document.getElementById('movers').innerHTML = movers.map(function (r) {
    return '<button type="button" class="mcard" data-slug="' + esc(r.slug) + '">' +
      '<span class="rk' + rkClass(r.rank) + '">' + r.rank + '</span>' +
      '<span class="m-main"><span class="m-name">' + esc(r.name) + '</span>' +
      '<span class="m-sub">implied ' + fmtUsd(r.implied_value_usd) + ' · TVL ' + fmtUsd(r.tvl_usd) + '</span></span>' +
      '<span class="m-pct">' + fmtPct(r.change_7d) + '</span></button>';
  }).join('');
  document.getElementById('movers').addEventListener('click', function (ev) {
    var card = ev.target.closest('[data-slug]');
    if (card) location.hash = 'p/' + card.getAttribute('data-slug');
  });

  // ---------- filters ----------
  var state = { q: '', cat: '', chain: '', minTvl: 5000000, sort: 'rank', watch: false };
  var catSel = document.getElementById('cat');
  var chainSel = document.getElementById('chain');
  var sortSel = document.getElementById('sort');
  var qInput = document.getElementById('q');
  var tvlInput = document.getElementById('mintvl');
  var tvlVal = document.getElementById('mintvl-val');
  var watchBox = document.getElementById('watchonly');
  var tbody = document.getElementById('rows');
  var countEl = document.getElementById('count');

  var cats = {};
  var chains = {};
  rows.forEach(function (r) {
    if (r.category) cats[r.category] = true;
    r.chains.forEach(function (c) { chains[c] = true; });
  });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
  });
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o);
  });
  tvlInput.max = Math.log10(maxTvl).toFixed(2);

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }
  function sorted(list) {
    var out = list.slice();
    var by = state.sort;
    out.sort(function (a, b) {
      if (by === 'value') return b.implied_value_usd - a.implied_value_usd || a.rank - b.rank;
      if (by === 'tvl') return b.tvl_usd - a.tvl_usd || a.rank - b.rank;
      if (by === 'growth') return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d) || a.rank - b.rank;
      if (by === 'age') return (b.age_years === null ? -1 : b.age_years) - (a.age_years === null ? -1 : a.age_years) || a.rank - b.rank;
      return a.rank - b.rank;
    });
    return out;
  }
  function chainText(r) {
    if (!r.chains.length) return '—';
    var head = r.chains.slice(0, 3).join(' · ');
    return esc(head) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '');
  }
  function renderBoard() {
    var list = sorted(filtered());
    countEl.innerHTML = 'Showing <b>' + list.length + '</b> of ' + rows.length + ' board rows · ' +
      R.stats.pre_token + ' protocols record no token · ' + R.stats.set_aside + ' set aside as wrapped, staked, bridged or exchange products';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No protocol on the board matches these filters.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function (r) {
      var pct = Math.max(1.5, (r.implied_value_usd / maxValue) * 100);
      return '<tr tabindex="0" data-slug="' + esc(r.slug) + '">' +
        '<td class="num"><span class="rk' + rkClass(r.rank) + '">' + r.rank + '</span></td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="wl">WATCHLIST</span>' : '') +
        '<span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorised') + '</td>' +
        '<td class="chains">' + chainText(r) + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_years) + '</td>' +
        '<td class="num vcell"><span class="vnum">' + fmtUsd(r.implied_value_usd) + '</span>' +
        '<span class="vbar"><i style="width:' + pct.toFixed(1) + '%"></i></span></td></tr>';
    }).join('');
  }

  qInput.addEventListener('input', function () { state.q = qInput.value; renderBoard(); });
  catSel.addEventListener('change', function () { state.cat = catSel.value; renderBoard(); });
  chainSel.addEventListener('change', function () { state.chain = chainSel.value; renderBoard(); });
  sortSel.addEventListener('change', function () { state.sort = sortSel.value; renderBoard(); });
  watchBox.addEventListener('change', function () { state.watch = watchBox.checked; renderBoard(); });
  tvlInput.addEventListener('input', function () {
    state.minTvl = Math.pow(10, parseFloat(tvlInput.value));
    tvlVal.textContent = fmtUsd(state.minTvl);
    renderBoard();
  });
  Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
    th.addEventListener('click', function () {
      state.sort = th.getAttribute('data-sort');
      sortSel.value = state.sort;
      renderBoard();
    });
  });
  tbody.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-slug]');
    if (tr) location.hash = 'p/' + tr.getAttribute('data-slug');
  });
  tbody.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var tr = ev.target.closest('tr[data-slug]');
    if (tr) location.hash = 'p/' + tr.getAttribute('data-slug');
  });

  // ---------- detail: the dossier ----------
  var boardView = document.getElementById('board-view');
  var detailView = document.getElementById('detail-view');

  function showDetail(r) {
    var base = r.tvl_usd * r.ratio;
    var afterMom = base * r.momentum_factor;
    var afterAge = afterMom * r.age_factor;
    var afterChains = afterAge * r.chain_factor;
    var listedLine = r.listed_at ? 'tracked since ' + r.listed_at : 'no listing date in the snapshot';
    var html = '<article class="dossier">' +
      '<button class="back" id="back-btn" type="button">← Back to the board</button>' +
      '<div class="d-head"><span class="rk' + rkClass(r.rank) + '">' + r.rank + '</span>' +
      '<div><h2 class="d-name">' + esc(r.name) + '</h2>' +
      '<p class="d-sub">' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + listedLine + '</p></div>' +
      '<span class="stamp">' + (r.watchlist ? 'Watchlist · Rank ' + r.rank : 'Radar find · Rank ' + r.rank) + '</span></div>' +

      '<dl class="stat-grid">' +
      '<div class="stat"><dt>Implied value</dt><dd>' + fmtUsd(r.implied_value_usd) + '<small>' + fmtFull(r.implied_value_usd) + '</small></dd></div>' +
      '<div class="stat"><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '<small>' + fmtFull(r.tvl_usd) + '</small></dd></div>' +
      '<div class="stat"><dt>Category ratio</dt><dd>' + r.ratio.toFixed(3) + '×<small>' + basisText(r) + '</small></dd></div>' +
      '<div class="stat"><dt>TVL change · 7d</dt><dd>' + fmtPct(r.change_7d) + '<small>momentum factor ×' + r.momentum_factor.toFixed(3) + '</small></dd></div>' +
      '<div class="stat"><dt>Tokenless age</dt><dd>' + (r.age_years === null ? 'n/a' : r.age_years.toFixed(2) + 'y') + '<small>age factor ×' + r.age_factor.toFixed(3) + '</small></dd></div>' +
      '<div class="stat"><dt>Chains</dt><dd>' + r.chains.length + '<small>breadth factor ×' + r.chain_factor.toFixed(3) + '</small></dd></div>' +
      '</dl>' +

      '<h3>Why this value — the model, line by line</h3>' +
      '<table class="breakdown">' +
      '<tr><td>TVL (the snapshot\u2019s figure)</td><td class="n">' + fmtFull(r.tvl_usd) + '</td><td class="why">what the protocol holds today</td></tr>' +
      '<tr><td>× category ratio ' + r.ratio.toFixed(3) + '</td><td class="n">' + fmtFull(base) + '</td><td class="why">' + basisText(r) + '</td></tr>' +
      '<tr><td>× momentum ' + r.momentum_factor.toFixed(3) + '</td><td class="n">' + fmtFull(afterMom) + '</td><td class="why">7d TVL change ' + (r.change_7d === null ? 'unreported, read as 0' : r.change_7d.toFixed(1) + '%') + ', clamped to ±30% at half weight</td></tr>' +
      '<tr><td>× tokenless age ' + r.age_factor.toFixed(3) + '</td><td class="n">' + fmtFull(afterAge) + '</td><td class="why">' + (r.age_years === null ? 'no listing date recorded — no bonus' : r.age_years.toFixed(2) + ' years at 2% a year, capped at five') + '</td></tr>' +
      '<tr><td>× chain breadth ' + r.chain_factor.toFixed(3) + '</td><td class="n">' + fmtFull(afterChains) + '</td><td class="why">' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ' at 1% per extra chain, capped at six</td></tr>' +
      '<tr class="total"><td>Implied value</td><td class="n">' + fmtFull(r.implied_value_usd) + '</td><td class="why">factors above are rounded to 4 places; the board\u2019s figure uses full precision</td></tr>' +
      '</table>' +
      compPanel(r) +
      '<p class="progress">Chains: ' + (r.chains.length ? esc(r.chains.join(', ')) : 'none recorded') + '</p>' +

      '<h3>Farm plan — ' + r.farm_steps.length + ' steps</h3>' +
      '<p class="plan-summary">Plan at a glance — <b>≈ ' + fmtFull(r.plan.capital_usd) + '</b> of capital deployed · ' +
      '<b>≈ $' + r.plan.fees_lo + '–$' + r.plan.fees_hi + '</b> in gas and fees · runs about <b>' + r.plan.weeks + ' weeks</b></p>' +
      '<p class="progress" id="plan-progress"><b>0</b> of ' + r.farm_steps.length + ' steps done</p>' +
      '<ol class="plan">' + r.farm_steps.map(function (s, i) {
        return '<li><input type="checkbox" data-step="' + i + '" aria-label="Step ' + (i + 1) + ' done">' +
          '<span class="step-n">' + (i + 1) + '</span><p>' + esc(s) + '</p></li>';
      }).join('') + '</ol>' +
      '</article>';
    detailView.innerHTML = html;
    boardView.hidden = true;
    detailView.hidden = false;
    window.scrollTo(0, 0);
    document.getElementById('back-btn').addEventListener('click', function () { location.hash = ''; });
    detailView.querySelectorAll('input[data-step]').forEach(function (box) {
      box.addEventListener('change', function () {
        box.closest('li').classList.toggle('done', box.checked);
        var done = detailView.querySelectorAll('input[data-step]:checked').length;
        document.getElementById('plan-progress').innerHTML = '<b>' + done + '</b> of ' + r.farm_steps.length + ' steps done';
      });
    });
  }

  function route() {
    var m = /^#p\/(.+)$/.exec(location.hash);
    if (m && bySlug[decodeURIComponent(m[1])]) {
      showDetail(bySlug[decodeURIComponent(m[1])]);
    } else {
      detailView.hidden = true;
      boardView.hidden = false;
    }
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !detailView.hidden) location.hash = '';
  });

  renderBoard();
  route();
})();
