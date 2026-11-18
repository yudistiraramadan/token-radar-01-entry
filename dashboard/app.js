// Token Launch Radar — the page logic. Reads window.BOARD_DATA (the ranked rows) and window.BOARD_META
// (the fitted model) from ../data.js, which main.ts writes from the same board as board.json. No network.
// State lives in the URL hash (#cat=RWA&open=gauntlet&q=…&sort=tvl_usd:desc) so every view is a link.
(function () {
  'use strict';
  var F = window.BOARD_DATA;
  var M = window.BOARD_META;
  var body = document.getElementById('body');
  if (!Array.isArray(F) || !M) {
    body.innerHTML = '<tr><td colspan="7" class="empty">data.js is missing: run main.ts to build the board.</td></tr>';
    return;
  }

  var AS_OF = Date.parse(M.as_of + 'T00:00:00Z');
  var S = { sortK: 'implied_value_usd', sortD: 'desc', filter: 'all', search: '', expanded: new Set() };
  var LABELS = { rank: '#', name: 'name', category: 'category', tvl_usd: 'tvl', change_7d: '7d', age: 'age', implied_value_usd: 'implied' };

  // ------------------------------------------------------------ formatting
  function fm(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n.toFixed(0);
  }
  function fp(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function ageDays(d) { return d ? Math.floor((AS_OF - Date.parse(d + 'T00:00:00Z')) / 86400000) : null; }
  function fa(d) {
    var days = ageDays(d);
    if (days == null) return '?';
    if (days < 90) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function maturityLabel(m) {
    return { 0.6: 'unproven <90d', 0.9: 'proving <1y', 1.1: 'sweet spot 1-2y', 1: 'mature 2-4y', 0.85: 'stale >4y', 0.95: 'no listing date' }[m] || '';
  }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  // ------------------------------------------------------------ the model, stated from data.js
  function fillMeta() {
    document.title = 'Token Launch Radar · ' + M.as_of;
    var scale = M.fit.scale.toLocaleString('en-US');
    setText('m-asof', M.as_of); setText('m-pre', M.pre_token); setText('m-comp', M.comparables);
    setText('m-scale', scale); setText('m-b', M.fit.b.toFixed(3)); setText('m-r2', M.fit.r2.toFixed(2));
    setText('m-watch', M.watchlist);
    setText('f-comp', M.comparables); setText('f-scale', scale); setText('f-b', M.fit.b.toFixed(3));
    setText('f-r2', M.fit.r2.toFixed(2)); setText('f-lo', M.clip.lo); setText('f-hi', M.clip.hi.toFixed(1));
    setText('f-watch', M.watchlist); setText('f-floor', fm(M.floor_usd)); setText('f-extras', M.extras);
    setText('f-pool', M.extras_pool); setText('f-asof', M.as_of); setText('f-src', M.source);
    document.getElementById('f-cats').innerHTML = M.categories.map(function (c) {
      return '<span class="cat">' + esc(c.category) + ' ' + c.mult.toFixed(2) + '× (n=' + c.n + ')</span>';
    }).join(', ');
  }

  // ------------------------------------------------------------ filter, sort, render
  function filtered() {
    var q = S.search.toLowerCase();
    return F.filter(function (r) {
      if (S.filter === 'watch' && !r.in_watchlist) return false;
      if (S.filter !== 'all' && S.filter !== 'watch' && r.category !== S.filter) return false;
      return !q || r.name.toLowerCase().indexOf(q) >= 0 || r.slug.indexOf(q) >= 0;
    });
  }
  function keyOf(r, k) {
    if (k === 'age') { var d = ageDays(r.listed_at); return d == null ? null : d; }
    return r[k];
  }
  function sorted(a) {
    var k = S.sortK, asc = S.sortD === 'asc';
    return a.slice().sort(function (x, y) {
      var av = keyOf(x, k), bv = keyOf(y, k);
      if (av == null && bv == null) return x.rank - y.rank;
      if (av == null) return 1; // missing values sink in both directions
      if (bv == null) return -1;
      if (typeof av === 'string') return (asc ? av.localeCompare(bv) : bv.localeCompare(av)) || x.rank - y.rank;
      return (asc ? av - bv : bv - av) || x.rank - y.rank;
    });
  }

  function renderRow(r) {
    var ex = S.expanded.has(r.slug);
    var pn = r.change_7d == null ? 'dim' : r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : 'dim';
    return '<tr class="row' + (r.in_watchlist ? ' star' : '') + (ex ? ' expanded' : '') + '" data-slug="' + esc(r.slug) +
      '" tabindex="0" aria-expanded="' + ex + '">' +
      '<td class="right num">' + (r.in_watchlist ? '★ ' : '') + r.rank + '</td>' +
      '<td class="left">' + esc(r.name) + '</td>' +
      '<td class="left muted">' + esc(r.category) + '</td>' +
      '<td class="right num">' + fm(r.tvl_usd) + '</td>' +
      '<td class="right num ' + pn + '">' + fp(r.change_7d) + '</td>' +
      '<td class="right num muted">' + fa(r.listed_at) + '</td>' +
      '<td class="right num accent">' + fm(r.implied_value_usd) + '</td></tr>' +
      (ex ? renderDetail(r) : '');
  }

  function renderDetail(r) {
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var chains = (r.chains || []).join(', ') || '—';
    var days = ageDays(r.listed_at);
    return '<tr class="detail-row"><td colspan="7"><div class="dg"><div>' +
      '<h4>Model breakdown</h4><table class="bk">' +
      '<tr><td>Base (size curve, ' + esc(r.category) + ')</td><td class="num">' + fm(r.base_usd) + '</td></tr>' +
      '<tr><td>× Growth mult (7d ' + fp(r.change_7d) + ')</td><td class="num">' + r.growth_mult.toFixed(2) + '×</td></tr>' +
      '<tr><td>× Maturity mult (' + maturityLabel(r.maturity_mult) + ')</td><td class="num">' + r.maturity_mult.toFixed(2) + '×</td></tr>' +
      '<tr class="total"><td>= Implied value · rank ' + r.rank + '</td><td class="num accent">' + fm(r.implied_value_usd) + '</td></tr></table>' +
      '<div class="meta">tvl     ' + fm(r.tvl_usd) + ' · implied/tvl ' + (r.implied_value_usd / r.tvl_usd).toFixed(3) + '×<br>' +
      'chains  ' + esc(chains) + '<br>' +
      'listed  ' + (r.listed_at || 'unknown') + (days == null ? '' : ' (' + days + ' days, ' + fa(r.listed_at) + ')') + '<br>' +
      'slug    ' + esc(r.slug) + '<br>' +
      (r.in_watchlist ? '★ watchlist (≥' + fm(M.floor_usd) + ', no token recorded)' : 'extra (pre-token, below the watchlist floor or outside it)') +
      '</div></div><div><h4>Farm plan — ' + r.farm_steps.length + ' steps</h4><ol class="steps">' + steps + '</ol></div></div></td></tr>';
  }

  function render() {
    var a = sorted(filtered());
    setText('rows-shown', a.length);
    body.innerHTML = a.map(renderRow).join('');
    document.getElementById('empty').hidden = a.length > 0;
    document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c.dataset.c === S.filter); });
    document.querySelectorAll('th[data-k]').forEach(function (t) {
      t.classList.toggle('on', t.dataset.k === S.sortK);
      t.classList.toggle('asc', t.dataset.k === S.sortK && S.sortD === 'asc');
      t.setAttribute('aria-sort', t.dataset.k === S.sortK ? (S.sortD === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    setText('sort-label', LABELS[S.sortK] + ' ' + (S.sortD === 'asc' ? '▲' : '▼'));
    writeHash();
  }

  // ------------------------------------------------------------ URL hash state
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 0) return;
      var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if (k === 'cat') S.filter = v;
      else if (k === 'q') S.search = v;
      else if (k === 'open') v.split(',').forEach(function (s) { if (s) S.expanded.add(s); });
      else if (k === 'sort') {
        var p = v.split(':');
        if (LABELS[p[0]]) { S.sortK = p[0]; S.sortD = p[1] === 'asc' ? 'asc' : 'desc'; }
      }
    });
    document.getElementById('search').value = S.search;
  }
  function writeHash() {
    var parts = [];
    if (S.filter !== 'all') parts.push('cat=' + encodeURIComponent(S.filter));
    if (S.search) parts.push('q=' + encodeURIComponent(S.search));
    if (S.expanded.size) parts.push('open=' + Array.from(S.expanded).map(encodeURIComponent).join(','));
    if (S.sortK !== 'implied_value_usd' || S.sortD !== 'desc') parts.push('sort=' + S.sortK + ':' + S.sortD);
    var next = parts.join('&');
    if (next !== window.location.hash.replace(/^#/, '')) {
      window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
    }
  }

  // ------------------------------------------------------------ controls
  function toggle(slug) {
    if (S.expanded.has(slug)) S.expanded.delete(slug); else S.expanded.add(slug);
    render();
    var tr = body.querySelector('tr.row[data-slug="' + CSS.escape(slug) + '"]');
    if (tr) tr.focus();
  }
  body.addEventListener('click', function (e) {
    var tr = e.target.closest('tr.row');
    if (tr) toggle(tr.getAttribute('data-slug'));
  });
  body.addEventListener('keydown', function (e) {
    var tr = e.target.closest('tr.row');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(tr.getAttribute('data-slug')); }
  });

  var cats = {};
  F.forEach(function (r) { cats[r.category] = (cats[r.category] || 0) + 1; });
  var topCats = Object.keys(cats).map(function (c) { return [c, cats[c]]; })
    .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); }).slice(0, 8);
  var watchN = F.filter(function (r) { return r.in_watchlist; }).length;
  document.getElementById('chips').innerHTML =
    '<button type="button" class="chip" data-c="all">ALL ' + F.length + '</button>' +
    '<button type="button" class="chip" data-c="watch">★ WATCHLIST ' + watchN + '</button>' +
    topCats.map(function (e) {
      return '<button type="button" class="chip" data-c="' + esc(e[0]) + '">' + esc(e[0].toUpperCase()) + ' ' + e[1] + '</button>';
    }).join('');
  document.getElementById('chips').addEventListener('click', function (e) {
    var c = e.target.closest('.chip');
    if (!c) return;
    S.filter = c.dataset.c;
    render();
  });
  document.getElementById('search').addEventListener('input', function (e) { S.search = e.target.value.trim(); render(); });

  document.querySelectorAll('th[data-k]').forEach(function (th) {
    th.tabIndex = 0;
    function sortBy() {
      var k = th.dataset.k;
      if (S.sortK === k) S.sortD = S.sortD === 'desc' ? 'asc' : 'desc';
      else { S.sortK = k; S.sortD = k === 'name' || k === 'category' || k === 'rank' ? 'asc' : 'desc'; }
      render();
    }
    th.addEventListener('click', sortBy);
    th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(); } });
  });

  // ------------------------------------------------------------ theme
  var tbtn = document.getElementById('theme-toggle');
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    tbtn.textContent = t === 'dark' ? '☾ Dark' : '☀ Light';
    try { localStorage.setItem('tr-theme', t); } catch (e) { /* storage blocked: theme still applies */ }
  }
  var saved = 'dark';
  try { saved = localStorage.getItem('tr-theme') || 'dark'; } catch (e) { /* default dark */ }
  setTheme(saved);
  tbtn.addEventListener('click', function () {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  fillMeta();
  readHash();
  render();
})();
