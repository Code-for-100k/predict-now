// dashboard.js — extracted from dashboard.html inline script (SEC-04 + SEC-06)
"use strict";

var YAC = 'https://cbtc-data-api.bitsafe.finance';
var APP = window.location.origin;
var ZORO = 'https://dev-api.zorowallet.com';
var ZORO_KEY = '';
var adminSecret = '';
var poolData = [];
var agentWallets = [];
var RETAIL_GAS_RATE = 2.47;

// Pre-approved wallets — these auto-accept but DO NOT earn rewards
var PRE_APPROVED_IDS = new Set([
  'df0c3fdb58::12200a976df35fa70038966d8fc1fdd86a3c1310e30d7e3d1d3d43dbe5f372c3ea94',
  '689e91029e::12202e732753e42faa1577be9f9efb22daaa1f85e8a3874695e2ed292e2883f0d0bc',
  '1ca79f9918::12206e3ad664f644c87a3dc169d5d4cf442fd897a32f2daaf1b165df975ce7a2f16d',
  '0afed9241a::1220320c5994fd50d10e15a687d336acf65d0ba07f94744d16d68291ac8bb65e2825',
]);

// ── Safe DOM helpers ──
function txt(s) { return String(s ?? ''); }

function createEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = txt(text);
  return el;
}

function createTableRow(cells) {
  var tr = document.createElement('tr');
  cells.forEach(function(c) {
    var td = document.createElement('td');
    if (c.className) td.className = c.className;
    if (c.colSpan) td.colSpan = c.colSpan;
    td.textContent = txt(c.text);
    tr.appendChild(td);
  });
  return tr;
}

function createMessageRow(colspan, text, cls) {
  var tr = document.createElement('tr');
  var td = document.createElement('td');
  td.colSpan = colspan;
  td.className = cls || 'text-slate-500';
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function clearAndSet(id, content) {
  var el = document.getElementById(id);
  el.textContent = '';
  if (typeof content === 'string') {
    el.textContent = content;
  } else if (content) {
    el.appendChild(content);
  }
  return el;
}

function createRewardBadge(partyId) {
  var span = document.createElement('span');
  span.className = PRE_APPROVED_IDS.has(partyId)
    ? 'inline-block ml-1 px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[9px] font-bold rounded'
    : 'inline-block ml-1 px-1.5 py-0.5 bg-green-500/20 text-green-400 text-[9px] font-bold rounded';
  span.textContent = PRE_APPROVED_IDS.has(partyId) ? 'PRE-APPROVED' : 'EARNS REWARDS';
  return span;
}

// ── Auth ──
function authenticate() {
  adminSecret = document.getElementById('admin-secret-input').value;
  if (!adminSecret) return;
  fetch(APP + '/admin/db-summary', { headers: { 'x-admin-secret': adminSecret } })
    .then(function(r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(function() {
      document.getElementById('auth-gate').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      refreshAll();
    })
    .catch(function() { alert('Invalid admin secret'); });
}

// ── Section Tabs ──
function showSection(name) {
  document.getElementById('section-revenue').classList.toggle('hidden', name !== 'revenue');
  document.getElementById('section-product').classList.toggle('hidden', name !== 'product');
  document.getElementById('tab-revenue').className = name === 'revenue' ? 'tab-active px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest border rounded transition-all' : 'tab-inactive px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest border rounded transition-all';
  document.getElementById('tab-product').className = name === 'product' ? 'tab-active px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest border rounded transition-all' : 'tab-inactive px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest border rounded transition-all';
}

// ── Helpers ──
function getDateRange() {
  var days = parseInt(document.getElementById('date-range').value);
  var end = new Date().toISOString().slice(0, 10);
  var start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return { start: start, end: end };
}

async function yac(path, body) {
  try {
    var r = await fetch(YAC + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    var d = await r.json();
    return d.success ? d.data : null;
  } catch(e) { return null; }
}

async function adminGet(path) {
  var r = await fetch(APP + path, { headers: { 'x-admin-secret': adminSecret } });
  return r.json();
}

function cc(val) { return parseFloat(val || 0).toFixed(4); }
function shortId(id) { return id ? id.substring(0, 10) + '...' + id.slice(-6) : '-'; }
function setVal(id, val, cls) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.classList.remove('loading');
  if (cls) el.className = el.className.replace(/text-\S+/, cls);
}

// ── CC View On-Chain Data ──
async function ccviewFetch(path) {
  var proxyPath = path.replace(/^\/api\//, '/api/ccview/');
  var res = await fetch(APP + proxyPath);
  return res.json();
}

async function loadCCViewData() {
  try {
    var today = new Date().toISOString().slice(0, 10);
    var results = await Promise.all([
      ccviewFetch('/api/v1/explore/prices'),
      ccviewFetch('/api/v1/rewards/daily_statistic?start=' + today + '&end=' + today + '&granularity=1h'),
    ]);
    var prices = results[0];
    var rewards = results[1];

    var ccPrice = parseFloat(prices.current || 0);
    window._ccPrice = ccPrice;
    var rewardData = rewards.data || [];
    var latestRound = rewardData.length > 0 ? rewardData[rewardData.length - 1].grp : '?';

    var rd = window._rewardData;
    if (rd && ccPrice > 0) {
      setVal('stat-cc-usd', '~$' + (rd.earned * ccPrice).toFixed(2));
    }

    document.getElementById('ccview-cc-price').textContent = '$' + ccPrice.toFixed(4);
    document.getElementById('ccview-mining-round').textContent = '#' + latestRound;
    document.getElementById('ccview-timestamp').textContent = 'as of ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('CC View fetch error:', err);
    document.getElementById('ccview-timestamp').textContent = 'error loading';
  }
}

async function refreshAll() {
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
  loadCCViewData();

  // Check circuit breaker state
  try {
    var cbRes = await fetch(APP + '/admin/circuit-breaker/status', { headers: { 'x-admin-secret': adminSecret } });
    var cb = await cbRes.json();
    var banner = document.getElementById('cb-banner');
    if (cb.tripped) {
      banner.className = 'mb-4 p-4 rounded-lg border bg-red-500/10 border-red-500/30';
      banner.textContent = '';
      var row = createEl('div', 'flex items-center gap-3');
      row.appendChild(createEl('span', 'text-red-500 text-lg font-black', 'CIRCUIT BREAKER ACTIVE'));
      row.appendChild(createEl('span', 'text-red-400 text-sm',
        'Auto-payouts paused, agents stopped. Net margin: ' + (cb.net_margin || 0).toFixed(4) + ' CC/txn. Tripped: ' + (cb.tripped_at ? new Date(cb.tripped_at).toLocaleString() : '?')));
      var resetBtn = createEl('button', 'ml-auto px-3 py-1 bg-red-500/20 border border-red-500/30 text-red-400 text-xs font-bold uppercase rounded hover:bg-red-500/30', 'Reset');
      resetBtn.addEventListener('click', resetCB);
      row.appendChild(resetBtn);
      banner.appendChild(row);
      banner.classList.remove('hidden');
    } else if (cb.net_margin > 0 && cb.net_margin < 1.0) {
      banner.className = 'mb-4 p-4 rounded-lg border bg-yellow-500/10 border-yellow-500/30';
      banner.textContent = '';
      var warnRow = createEl('div', 'flex items-center gap-3');
      warnRow.appendChild(createEl('span', 'text-yellow-500 font-bold', 'MARGIN WATCH'));
      warnRow.appendChild(createEl('span', 'text-yellow-400 text-sm',
        'Net margin: ' + cb.net_margin.toFixed(4) + ' CC/txn (threshold: ' + (cb.config?.min_margin || 0.5) + ' CC)'));
      banner.appendChild(warnRow);
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch(e) {}

  // Get pool wallet IDs
  try {
    var rewardsRes = await fetch(APP + '/admin/rewards', { headers: { 'x-admin-secret': adminSecret }, signal: AbortSignal.timeout(130000) });
    var rewardsData = await rewardsRes.json();
    if (rewardsData.pool_wallets_detail) {
      poolData = rewardsData.pool_wallets_detail;
    }
  } catch(e) {}

  if (poolData.length === 0) {
    poolData = [
      { name: 'retail', tier: 'retail', id: '8324e2529b::1220efd7374bb65d1ce76f9cf6cfa7f4e9fd896179980d624485978ed0cf46c76d37' },
      { name: 'inst1', tier: 'institutional', id: '0afed9241a::1220320c5994fd50d10e15a687d336acf65d0ba07f94744d16d68291ac8bb65e2825' },
      { name: 'inst2', tier: 'institutional', id: '394df865bf::122058ec34c21cd7707c60c31b0ca721944612b2deb5fa59aeda8a62a06d824257a1' },
      { name: 'inst3', tier: 'institutional', id: '702758b398::12205271e3242c223dcbf092f3012f54265930c2a2eb465dbd45315d64a34bcfba2f' },
    ];
  }

  try {
    var r = await fetch(APP + '/admin/rewards?wallets=true', { headers: { 'x-admin-secret': adminSecret } });
    var d = await r.json();
    agentWallets = d.agent_wallets || [];
  } catch(e) { agentWallets = []; }

  await Promise.all([loadRevenueSection(), loadProductSection()]);
}

// ═══ REVENUE SECTION ═══
async function loadRevenueSection() {
  var range = getDateRange();
  var start = range.start;
  var end = range.end;
  var allPoolIds = poolData.map(function(p) { return p.id; }).filter(Boolean);
  var agentIds = agentWallets.map(function(w) { return w.partyId || w.party_id; }).filter(Boolean);
  var agentPreApprovedIds = [
    'df0c3fdb58::12200a976df35fa70038966d8fc1fdd86a3c1310e30d7e3d1d3d43dbe5f372c3ea94',
    '689e91029e::12202e732753e42faa1577be9f9efb22daaa1f85e8a3874695e2ed292e2883f0d0bc',
    '1ca79f9918::12206e3ad664f644c87a3dc169d5d4cf442fd897a32f2daaf1b165df975ce7a2f16d',
  ];
  var allIds = Array.from(new Set(allPoolIds.concat(agentIds).concat(agentPreApprovedIds)));

  var results = await Promise.all([
    yac('/api/v1/analytics/transfer-reward-aggregation', { parties: allIds, start_date: start, end_date: end }),
    yac('/api/v1/analytics/daily-rewards', { parties: allIds, start_date: start, end_date: end }),
    fetch('/admin/zoro-stats', { headers: { 'x-admin-secret': adminSecret } }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
  ]);
  var rewardAgg = results[0];
  var dailyRewards = results[1];
  var zoroStats = results[2];

  var earned = rewardAgg ? parseFloat(rewardAgg.total_cc_reward || 0) : 0;
  var rewardPerTx = rewardAgg ? parseFloat(rewardAgg.reward_per_tx || 0) : 0;
  var zoro = zoroStats?.totals || {};
  var totalTxns = zoro.total_cbtc_transfers || (rewardAgg?.total_transfer_offers || 0);

  window._rewardData = { earned: earned, rewardPerTx: rewardPerTx, totalTxns: totalTxns };

  if (rewardAgg || zoroStats) {
    var yakTxns = rewardAgg ? (rewardAgg.total_transfer_offers || 0) : totalTxns;
    var trackedTxns = rewardAgg ? (rewardAgg.accepted_transfer_offers || 0) : 0;
    var pendingTxns = yakTxns - trackedTxns;
    var trackedRewards = earned;
    var pendingRewards = pendingTxns * rewardPerTx;
    var totalRewards = trackedRewards + pendingRewards;
    var estGasCost = yakTxns * RETAIL_GAS_RATE;
    var netPosition = totalRewards - estGasCost;
    var marginPerTxn = rewardPerTx - RETAIL_GAS_RATE;

    setVal('stat-potential-total', cc(totalRewards) + ' CC');
    setVal('stat-potential-note', cc(trackedRewards) + ' tracked + ' + cc(pendingRewards) + ' pending \u2014 ~$' + (totalRewards * 0.155).toFixed(2));
    setVal('stat-gas-total', cc(estGasCost) + ' CC');
    setVal('stat-gas-total-usd', yakTxns + ' txns \u00D7 ' + RETAIL_GAS_RATE + ' CC/txn \u2014 ~$' + (estGasCost * 0.155).toFixed(2));

    var npEl = document.getElementById('stat-net-profit');
    if (npEl) {
      npEl.textContent = (netPosition >= 0 ? '+' : '') + cc(netPosition) + ' CC';
      npEl.className = npEl.className.replace(/text-(?:green|red)-\d+/g, '');
      npEl.classList.add(netPosition >= 0 ? 'text-green-400' : 'text-red-400');
    }
    setVal('stat-net-profit-usd', '~$' + (Math.abs(netPosition) * 0.155).toFixed(2) + ' ' + (netPosition >= 0 ? 'profit' : 'loss'));

    var mpEl = document.getElementById('stat-margin-per-txn');
    if (mpEl) {
      mpEl.textContent = (marginPerTxn >= 0 ? '+' : '') + cc(marginPerTxn) + ' CC';
      mpEl.className = mpEl.className.replace(/text-(?:green|red)-\d+/g, '');
      mpEl.classList.add(marginPerTxn >= 0 ? 'text-green-400' : 'text-red-400');
    }

    setVal('stat-reward-per-tx', cc(rewardPerTx) + ' CC');
    setVal('stat-gas-per-txn', RETAIL_GAS_RATE + ' CC');
    setVal('stat-total-txns', yakTxns.toString());
    setVal('stat-cc-earned', cc(earned) + ' CC');
    setVal('stat-cc-usd', '~$' + (earned * 0.155).toFixed(2) + ' \u2014 tracked in Yak');

    setVal('stat-tracked-rewards', cc(trackedRewards) + ' CC');
    setVal('stat-untracked-rewards', cc(pendingRewards) + ' CC');
    setVal('stat-twostep-txns', trackedTxns.toString());
    setVal('stat-preapproval-txns', pendingTxns.toString());
  } else {
    setVal('stat-cc-earned', 'API unavailable');
    ['stat-potential-total','stat-net-profit','stat-reward-per-tx','stat-total-txns','stat-tracked-rewards','stat-untracked-rewards','stat-twostep-txns','stat-preapproval-txns'].forEach(function(id) { setVal(id, '--'); });
  }

  await loadPoolTable(start, end);
  await loadAgentSummary(start, end);

  // Daily breakdown
  if (dailyRewards && dailyRewards.daily_rewards) {
    var tbody = document.getElementById('daily-body');
    var rows = dailyRewards.daily_rewards.sort(function(a, b) { return b.date.localeCompare(a.date); });
    tbody.textContent = '';
    if (rows.length === 0) {
      tbody.appendChild(createMessageRow(6, 'No data for this period'));
    } else {
      rows.forEach(function(d) {
        tbody.appendChild(createTableRow([
          { text: d.date, className: 'font-bold' },
          { text: d.transfer_creation_count },
          { text: d.accepted_transfer_count },
          { text: cc(d.total_reward), className: 'text-amber-500 font-bold' },
          { text: cc(d.client_reward), className: 'text-green-400' },
          { text: cc(d.reward_per_tx), className: 'text-slate-400' },
        ]));
      });
    }
  }
}

async function loadPoolTable(start, end) {
  var tbody = document.getElementById('pool-body');
  var details = [];
  var totalGas = 0;
  try {
    var res = await fetch(APP + '/admin/rewards?start=' + start + '&end=' + end, { headers: { 'x-admin-secret': adminSecret }, signal: AbortSignal.timeout(130000) });
    var data = await res.json();
    details = data.pool_wallets_detail || [];
    totalGas = data.total_gas_spent_cc || 0;
  } catch(e) {}

  tbody.textContent = '';
  var totalPoolSends = 0;
  var pools = details.length ? details : poolData;

  for (var i = 0; i < pools.length; i++) {
    var pool = pools[i];
    var id = pool.id;
    if (!id) {
      var noConfigRow = document.createElement('tr');
      var tdName = createEl('td', null, pool.name);
      var tdMsg = createEl('td', 'text-slate-500', 'Not configured');
      tdMsg.colSpan = 7;
      noConfigRow.appendChild(tdName);
      noConfigRow.appendChild(tdMsg);
      tbody.appendChild(noConfigRow);
      continue;
    }

    var poolResults = await Promise.all([
      yac('/api/v1/analytics/transfer-reward-aggregation', { parties: [id], start_date: start, end_date: end }),
      yac('/api/v1/events/transfer-offers/count', { sender: [id], instrument_id: 'CBTC' }),
      yac('/api/v1/events/transfer-offers/count', { receiver: [id], instrument_id: 'CBTC' }),
    ]);
    var rewardAgg = poolResults[0];
    var outC = poolResults[1];
    var inC = poolResults[2];

    totalPoolSends += (outC || 0);
    var tier = pool.tier || 'retail';
    var tierColor = tier === 'retail' ? 'text-amber-500' : 'text-purple-400';
    var cbtcBal = pool.cbtc_balance != null ? parseFloat(pool.cbtc_balance).toFixed(8) : '--';
    var ccBal = pool.cc_balance != null ? cc(pool.cc_balance.toString()) : '--';
    var gasSpent = pool.gas_spent != null ? cc(pool.gas_spent.toString()) : '--';

    var tr = document.createElement('tr');
    tr.dataset.tier = tier;

    var tdPoolName = createEl('td', 'font-bold', pool.name);
    tdPoolName.appendChild(createRewardBadge(id));

    tr.appendChild(tdPoolName);
    tr.appendChild(createEl('td', tierColor + ' font-bold text-xs', tier.toUpperCase()));
    tr.appendChild(createEl('td', 'mono', cbtcBal));
    tr.appendChild(createEl('td', 'mono', ccBal));
    tr.appendChild(createEl('td', null, outC || 0));
    tr.appendChild(createEl('td', null, inC || 0));
    tr.appendChild(createEl('td', 'text-amber-500 font-bold', rewardAgg ? cc(rewardAgg.total_cc_reward) : '0'));
    tr.appendChild(createEl('td', 'text-red-400', gasSpent));

    tbody.appendChild(tr);
  }

  if (tbody.children.length === 0) {
    tbody.appendChild(createMessageRow(8, 'No pool wallets'));
  }

  setVal('stat-gas-spent', cc(totalGas.toString()) + ' CC');
  var gasPerSend = totalPoolSends > 0 && totalGas > 0 ? totalGas / totalPoolSends : 0;
  setVal('stat-preapproval-cost', gasPerSend > 0 ? cc(gasPerSend.toString()) + ' CC' : '0 CC');
  setVal('stat-twostep-cost', gasPerSend > 0 ? cc(gasPerSend.toString()) + ' CC' : '0 CC');
}

async function resetCB() {
  if (!confirm('Reset circuit breaker? This will restart agents and re-enable auto-payouts.')) return;
  await fetch(APP + '/admin/circuit-breaker/reset', { method: 'POST', headers: { 'x-admin-secret': adminSecret } });
  refreshAll();
}

function filterPool(f) {
  document.querySelectorAll('.pool-filter').forEach(function(b) {
    b.className = b.dataset.f === f
      ? 'pool-filter tab-active px-3 py-1 text-[10px] font-bold uppercase tracking-widest border rounded'
      : 'pool-filter tab-inactive px-3 py-1 text-[10px] font-bold uppercase tracking-widest border rounded';
  });
  document.querySelectorAll('#pool-body tr').forEach(function(tr) {
    if (f === 'all') { tr.style.display = ''; return; }
    tr.style.display = tr.dataset.tier === f ? '' : 'none';
  });
}

async function loadAgentSummary(start, end) {
  var agentIds = agentWallets.map(function(w) { return w.partyId || w.party_id; }).filter(Boolean);
  setVal('agent-total', agentIds.length.toString());

  if (agentIds.length === 0) {
    setVal('agent-active', '0');
    setVal('agent-rewards', '0 CC');
    setVal('agent-gas', '0 CC');
    return;
  }

  var rewardAgg = await yac('/api/v1/analytics/transfer-reward-aggregation', { parties: agentIds, start_date: start, end_date: end });
  var activeCount = rewardAgg ? (rewardAgg.accepted_transfer_offers || 0) : 0;
  setVal('agent-active', activeCount > 0 ? activeCount + ' txns' : '0');
  setVal('agent-rewards', rewardAgg ? cc(rewardAgg.total_cc_reward) + ' CC' : '0 CC');
  setVal('agent-gas', '0 CC');

  var detailEl = document.getElementById('agent-detail');
  detailEl.textContent = '';
  var preApprovedCount = agentIds.filter(function(id) { return PRE_APPROVED_IDS.has(id); }).length;
  var earnsRewardsCount = agentIds.length - preApprovedCount;

  var p1 = createEl('p', 'text-xs ' + (activeCount === 0 ? 'text-slate-500' : 'text-slate-400'),
    activeCount === 0 ? 'No agent wallet activity yet.' : activeCount + ' transactions across agent wallets.');
  detailEl.appendChild(p1);

  var p2 = document.createElement('p');
  p2.className = 'text-xs text-slate-500 mt-1';
  var preSpan = createEl('span', 'text-red-400 font-bold', preApprovedCount);
  p2.appendChild(preSpan);
  p2.appendChild(document.createTextNode(' pre-approved (no rewards) \u00B7 '));
  var earnSpan = createEl('span', 'text-green-400 font-bold', earnsRewardsCount);
  p2.appendChild(earnSpan);
  p2.appendChild(document.createTextNode(' manual accept (earns rewards)'));
  detailEl.appendChild(p2);
}

// ═══ PRODUCT SECTION ═══
async function loadProductSection() {
  var dbData = await adminGet('/admin/db-summary');

  setVal('prod-users', (dbData.users || 0).toString());
  setVal('prod-rounds', (dbData.rounds || 0).toString());
  setVal('prod-bets', (dbData.predictions || 0).toString());
  setVal('prod-deposits', (dbData.deposits || 0).toString());
  setVal('prod-withdrawals', (dbData.withdrawals || 0).toString());

  // Tier breakdown
  var tierEl = document.getElementById('tier-breakdown');
  tierEl.classList.remove('loading');
  tierEl.textContent = '';
  var retail = dbData.users_by_tier?.retail || 0;
  var inst = dbData.users_by_tier?.institutional || 0;

  var tierFlex = createEl('div', 'flex gap-6');
  function addTierCol(label, value, cls) {
    var col = document.createElement('div');
    col.appendChild(createEl('div', 'text-[9px] font-bold text-slate-500 uppercase mb-1', label));
    col.appendChild(createEl('div', 'text-xl font-black ' + (cls || ''), value));
    tierFlex.appendChild(col);
  }
  addTierCol('Retail Users', retail, 'text-amber-500');
  addTierCol('Institutional Users', inst, 'text-purple-400');
  addTierCol('Total', dbData.users || 0);
  tierEl.appendChild(tierFlex);

  // Invite codes
  var codes = await adminGet('/admin/invite-codes');
  var inviteBody = document.getElementById('invite-body');
  inviteBody.textContent = '';
  if (codes.codes && codes.codes.length > 0) {
    var seen = new Set();
    var unique = codes.codes.filter(function(c) { if (seen.has(c.code)) return false; seen.add(c.code); return true; });
    unique.slice(0, 20).forEach(function(c) {
      var used = c.used_count || 0;
      var max = c.max_uses || 1;
      var statusColor = used >= max ? 'text-red-400' : used > 0 ? 'text-amber-500' : 'text-green-400';
      var statusText = used >= max ? 'Full' : used > 0 ? 'Active' : 'Available';
      inviteBody.appendChild(createTableRow([
        { text: c.code, className: 'mono font-bold text-xs' },
        { text: c.tier || 'retail', className: 'text-xs' },
        { text: used },
        { text: max },
        { text: statusText, className: statusColor + ' font-bold' },
      ]));
    });
    if (unique.length > 20) {
      inviteBody.appendChild(createMessageRow(5, '...and ' + (unique.length - 20) + ' more codes', 'text-slate-500 text-xs'));
    }
  } else {
    inviteBody.appendChild(createMessageRow(5, 'No invite codes'));
  }

  // User balances
  var balBody = document.getElementById('balances-body');
  balBody.textContent = '';
  if (dbData.balances && dbData.balances.length > 0) {
    var balRows = dbData.balances.filter(function(b) { return b.balance > 0 || b.total_deposited > 0; });
    if (balRows.length > 0) {
      balRows.forEach(function(b) {
        balBody.appendChild(createTableRow([
          { text: (b.uid?.substring(0, 12) || '--') + '...', className: 'mono text-xs' },
          { text: b.tier || 'retail', className: 'text-xs' },
          { text: parseFloat(b.balance || 0).toFixed(8), className: 'font-bold' },
          { text: parseFloat(b.total_deposited || 0).toFixed(8), className: 'text-green-400' },
          { text: parseFloat(b.total_won || 0).toFixed(8), className: 'text-amber-500' },
          { text: parseFloat(b.total_lost || 0).toFixed(8), className: 'text-red-400' },
          { text: parseFloat(b.total_withdrawn || 0).toFixed(8) },
        ]));
      });
    } else {
      balBody.appendChild(createMessageRow(7, 'No user balances'));
    }
  } else {
    balBody.appendChild(createMessageRow(7, 'No user balances'));
  }

  // Current state
  var stateEl = document.getElementById('current-state');
  stateEl.classList.remove('loading');
  stateEl.textContent = '';
  if (dbData.active_round) {
    var grid = createEl('div', 'grid grid-cols-2 md:grid-cols-4 gap-4 text-sm');
    function addStateCol(label, value, cls) {
      var col = document.createElement('div');
      col.appendChild(createEl('span', 'text-slate-500 text-xs block', label));
      col.appendChild(createEl('span', 'font-bold' + (cls ? ' ' + cls : ''), value));
      grid.appendChild(col);
    }
    addStateCol('Active Round', '#' + dbData.active_round.round_number);
    addStateCol('Lock Price', '$' + (dbData.active_round.open_price || 0).toLocaleString());
    addStateCol('UP Pool', dbData.active_round.total_up_amount || 0, 'text-green-400');
    addStateCol('DOWN Pool', dbData.active_round.total_down_amount || 0, 'text-red-400');
    stateEl.appendChild(grid);
  } else {
    stateEl.appendChild(createEl('span', 'text-slate-500', 'No active round'));
  }
}

// ── Wire up event listeners (replacing inline onclick handlers) ──
document.getElementById('admin-secret-input').addEventListener('keydown', function(e) { if (e.key === 'Enter') authenticate(); });
document.getElementById('date-range').addEventListener('change', refreshAll);

document.querySelector('[data-action="refresh"]').addEventListener('click', refreshAll);
document.querySelector('[data-action="authenticate"]').addEventListener('click', authenticate);
document.querySelector('[data-action="show-revenue"]').addEventListener('click', function() { showSection('revenue'); });
document.querySelector('[data-action="show-product"]').addEventListener('click', function() { showSection('product'); });

document.querySelectorAll('[data-action="filter-pool"]').forEach(function(btn) {
  btn.addEventListener('click', function() { filterPool(btn.dataset.f); });
});

// Auto-refresh every 2 minutes
setInterval(function() { if (!document.getElementById('dashboard').classList.contains('hidden')) refreshAll(); }, 120000);
