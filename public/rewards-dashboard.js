// rewards-dashboard.js — extracted from rewards-dashboard.html inline script (SEC-04)
"use strict";

var rawData = null;
var filterWallets = [];

function createTextNode(s) {
  return String(s ?? '');
}

// Helper to create a table row with cells
function createTableRow(cells) {
  var tr = document.createElement('tr');
  cells.forEach(function(cell) {
    var td = document.createElement('td');
    if (cell.className) td.className = cell.className;
    td.textContent = cell.text;
    tr.appendChild(td);
  });
  return tr;
}

// Helper to create a single-cell message row
function createMessageRow(colspan, text, className) {
  var tr = document.createElement('tr');
  var td = document.createElement('td');
  td.colSpan = colspan;
  td.className = className || 'text-slate-500 text-center py-8';
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

async function loadData() {
  var key = document.getElementById('key-input').value.trim();
  if (!key) return alert('Please enter your rewards API key');

  var dailyTable = document.getElementById('daily-table');
  dailyTable.textContent = '';
  dailyTable.appendChild(createMessageRow(6, 'Loading...', 'text-slate-500 text-center py-8 loading'));

  try {
    var res = await fetch('/api/rewards', { headers: { 'x-rewards-key': key } });
    if (!res.ok) { var e = await res.json(); throw new Error(e.error || res.statusText); }
    rawData = await res.json();
    renderData();
  } catch (err) {
    var errTable = document.getElementById('daily-table');
    errTable.textContent = '';
    errTable.appendChild(createMessageRow(6, err.message, 'text-red-400 text-center py-8'));
  }
}

function applyFilter() {
  var val = document.getElementById('wallet-filter').value.trim();
  if (!val) { filterWallets = []; }
  else { filterWallets = val.split(/[,\n]/).map(function(s) { return s.trim(); }).filter(Boolean); }
  if (rawData) renderData();
}

function clearFilter() {
  document.getElementById('wallet-filter').value = '';
  filterWallets = [];
  if (rawData) renderData();
}

function renderData() {
  var d = rawData;
  if (!d) return;

  // Summary
  var totalCC = d.summary?.total_rewards_cc || d.total_rewards_cc || 0;
  var totalTxns = d.summary?.total_transactions || d.total_transactions || 0;
  var avgReward = totalTxns > 0 ? (totalCC / totalTxns) : 0;
  var cb = d.circuit_breaker || {};

  document.getElementById('total-cc').textContent = totalCC.toFixed(4) + ' CC';
  document.getElementById('total-usd').textContent = d.summary?.total_rewards_usd ? '\u2248 $' + d.summary.total_rewards_usd.toFixed(2) : '';
  document.getElementById('total-txns').textContent = totalTxns.toLocaleString();
  document.getElementById('avg-reward').textContent = avgReward.toFixed(6) + ' CC';

  var cbEl = document.getElementById('cb-status');
  if (cb.tripped) {
    cbEl.textContent = 'TRIPPED';
    cbEl.className = 'text-2xl font-bold stat-value cb-tripped';
  } else {
    cbEl.textContent = 'OK';
    cbEl.className = 'text-2xl font-bold stat-value cb-ok';
  }

  // Daily breakdown
  var days = d.daily || d.summary?.daily || [];
  var dailyTable = document.getElementById('daily-table');
  dailyTable.textContent = '';

  if (days.length === 0) {
    dailyTable.appendChild(createMessageRow(6, 'No daily data available'));
  } else {
    days.forEach(function(day) {
      var txns = day.transactions || day.total_transactions || 0;
      var rewards = day.rewards_cc || day.total_rewards || 0;
      var gas = day.gas_cost_cc || day.total_gas || 0;
      var net = rewards - gas;
      var avg = txns > 0 ? (rewards / txns) : 0;

      dailyTable.appendChild(createTableRow([
        { text: day.date, className: 'mono' },
        { text: String(txns) },
        { text: rewards.toFixed(4), className: 'text-emerald-400' },
        { text: gas.toFixed(4), className: 'text-amber-400' },
        { text: net.toFixed(4), className: net >= 0 ? 'text-emerald-400' : 'text-red-400' },
        { text: avg.toFixed(6) },
      ]));
    });
  }

  // Per-wallet breakdown
  var wallets = d.wallets || d.summary?.wallets || [];
  if (wallets.length > 0) {
    document.getElementById('wallet-section').style.display = 'block';
    var filtered = filterWallets.length > 0
      ? wallets.filter(function(w) { return filterWallets.some(function(f) { return (w.party_id || w.wallet || '').includes(f); }); })
      : wallets;

    var walletTable = document.getElementById('wallet-table');
    walletTable.textContent = '';

    if (filtered.length === 0) {
      walletTable.appendChild(createMessageRow(4, 'No matching wallets', 'text-slate-500 text-center py-4'));
    } else {
      filtered.forEach(function(w) {
        var id = w.party_id || w.wallet || '\u2014';
        var txns = w.transactions || 0;
        var rewards = w.rewards_cc || w.total_rewards || 0;
        var avg = txns > 0 ? (rewards / txns) : 0;

        walletTable.appendChild(createTableRow([
          { text: id.substring(0, 40) + '...', className: 'mono' },
          { text: String(txns) },
          { text: rewards.toFixed(4), className: 'text-emerald-400' },
          { text: avg.toFixed(6) },
        ]));
      });
    }
  }
}

// Wire up event listeners (replacing inline onclick handlers)
document.addEventListener('DOMContentLoaded', function() {
  var loadBtn = document.querySelector('[data-action="load"]');
  if (loadBtn) loadBtn.addEventListener('click', loadData);

  var applyBtn = document.querySelector('[data-action="apply-filter"]');
  if (applyBtn) applyBtn.addEventListener('click', applyFilter);

  var clearBtn = document.querySelector('[data-action="clear-filter"]');
  if (clearBtn) clearBtn.addEventListener('click', clearFilter);
});
