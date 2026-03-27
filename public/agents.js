// agents.js — extracted from agents.html inline script (SEC-04)
"use strict";

const adminSecret = sessionStorage.getItem('admin_secret') || prompt('Admin secret:');
if (adminSecret) sessionStorage.setItem('admin_secret', adminSecret);

const hdr = { 'x-admin-secret': adminSecret };

function createTextNode(s) {
  return String(s ?? '');
}

async function loadAgentStatus() {
  try {
    const res = await fetch('/admin/agents/status', { headers: hdr });
    if (!res.ok) throw new Error('Auth failed');
    const d = await res.json();

    // Status indicator
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (d.process_running) {
      dot.className = 'w-2 h-2 rounded-full bg-green-400 pulse';
      txt.textContent = 'Agents running (PID ' + (d.process_pid || '?') + ')';
      txt.className = 'text-[10px] text-green-400';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-red-400';
      txt.textContent = 'Agents stopped';
      txt.className = 'text-[10px] text-red-400';
    }

    // Hero stats
    document.getElementById('stat-total-bets').textContent = (d.totals?.total_agent_bets || 0).toLocaleString();
    document.getElementById('stat-retail-bets').textContent = (d.totals?.total_retail_bets || 0).toLocaleString();
    document.getElementById('stat-coverage').textContent = (d.coverage?.coverage_pct || 0) + '%';
    document.getElementById('stat-agent-count').textContent = (d.agents || []).length;

    const cbEl = document.getElementById('stat-cb');
    if (d.circuit_breaker?.tripped) {
      cbEl.textContent = 'TRIPPED';
      cbEl.className = 'text-2xl font-black text-red-400';
    } else {
      cbEl.textContent = 'OK';
      cbEl.className = 'text-2xl font-black text-green-400';
    }

    // Per-agent cards
    const cards = document.getElementById('agent-cards');
    if (d.agents && d.agents.length > 0) {
      cards.textContent = '';
      d.agents.forEach(function(a) {
        var wrClass = a.win_rate >= 50 ? 'text-green-400' : a.win_rate >= 40 ? 'text-yellow-400' : 'text-red-400';
        var pnl = a.pnl_pct || 0;
        var pnlClass = pnl >= 0 ? 'text-green-400' : 'text-red-400';
        var pnlSign = pnl >= 0 ? '+' : '';

        var card = document.createElement('div');
        card.className = 'card p-4';

        var header = document.createElement('div');
        header.className = 'flex items-center justify-between mb-3';

        var nameDiv = document.createElement('div');
        nameDiv.className = 'text-sm font-bold text-white';
        nameDiv.textContent = createTextNode(a.name);

        var statusDiv = document.createElement('div');
        statusDiv.className = 'text-[10px] px-2 py-0.5 rounded-full ' + (a.recent_bets > 0 ? 'bg-green-400/10 text-green-400' : 'bg-slate-700 text-slate-400');
        statusDiv.textContent = a.recent_bets > 0 ? 'active' : 'idle';

        header.appendChild(nameDiv);
        header.appendChild(statusDiv);
        card.appendChild(header);

        var grid = document.createElement('div');
        grid.className = 'grid grid-cols-4 gap-2 text-center';

        function addStat(value, label, cls) {
          var col = document.createElement('div');
          var valEl = document.createElement('div');
          valEl.className = 'text-lg font-black ' + (cls || 'text-white');
          valEl.textContent = createTextNode(value);
          var labEl = document.createElement('div');
          labEl.className = 'text-[9px] text-slate-500';
          labEl.textContent = label;
          col.appendChild(valEl);
          col.appendChild(labEl);
          grid.appendChild(col);
        }

        addStat(a.total_bets, 'bets');
        addStat(a.win_rate + '%', 'win rate', wrClass);
        addStat(a.wins + '/' + a.losses, 'W/L');
        addStat(pnlSign + pnl.toFixed(1) + '%', 'P&L', pnlClass);

        card.appendChild(grid);
        cards.appendChild(card);
      });
    }

    // Recent rounds
    var tbody = document.getElementById('rounds-body');
    if (d.recent_rounds && d.recent_rounds.length > 0) {
      tbody.textContent = '';
      d.recent_rounds.forEach(function(r) {
        var tr = document.createElement('tr');
        if (!(r.agent_bets > 0)) tr.className = 'opacity-40';

        var tdRound = document.createElement('td');
        tdRound.className = 'font-mono font-bold';
        tdRound.textContent = createTextNode(r.round);

        var tdWinner = document.createElement('td');
        tdWinner.className = (r.winning_direction === 'UP' ? 'bet-up' : 'bet-down') + ' font-bold';
        tdWinner.textContent = createTextNode(r.winning_direction || '--');

        var tdTotal = document.createElement('td');
        tdTotal.textContent = createTextNode(r.total_bets);

        var tdAgent = document.createElement('td');
        tdAgent.textContent = createTextNode(r.agent_bets);

        var tdDirs = document.createElement('td');
        tdDirs.className = 'text-[11px]';

        if (r.agents && r.agents.length > 0) {
          r.agents.forEach(function(a, idx) {
            if (idx > 0) {
              tdDirs.appendChild(document.createTextNode(' \u00B7 '));
            }
            var span = document.createElement('span');
            span.className = a.direction === 'UP' ? 'bet-up' : 'bet-down';
            var icon = a.direction === 'UP' ? '\u2191' : '\u2193';
            var result = a.won === true ? ' \u2713' : a.won === false ? ' \u2717' : '';
            span.textContent = createTextNode(a.name) + ' ' + icon + result;
            tdDirs.appendChild(span);
          });
        } else {
          var noAgents = document.createElement('span');
          noAgents.className = 'text-slate-600';
          noAgents.textContent = 'no agent bets';
          tdDirs.appendChild(noAgents);
        }

        tr.appendChild(tdRound);
        tr.appendChild(tdWinner);
        tr.appendChild(tdTotal);
        tr.appendChild(tdAgent);
        tr.appendChild(tdDirs);
        tbody.appendChild(tr);
      });
    }
  } catch (e) {
    document.getElementById('status-text').textContent = 'Error: ' + e.message;
  }
}

async function loadLiveRound() {
  try {
    var res = await fetch('/api/market/status');
    var d = await res.json();
    var el = document.getElementById('live-round');
    el.textContent = '';

    if (d.status === 'active') {
      var timeLeft = Math.max(0, Math.round((d.time_remaining_ms || 0) / 1000));

      var row = document.createElement('div');
      row.className = 'flex items-center justify-between';

      // Left: round info
      var leftDiv = document.createElement('div');
      var roundSpan = document.createElement('span');
      roundSpan.className = 'text-lg font-black text-white';
      roundSpan.textContent = 'Round ' + createTextNode(d.round_number);
      var timeSpan = document.createElement('span');
      timeSpan.className = 'text-[10px] text-slate-500 ml-3';
      timeSpan.textContent = createTextNode(timeLeft) + 's remaining';
      leftDiv.appendChild(roundSpan);
      leftDiv.appendChild(timeSpan);

      // Center: predictions
      var centerDiv = document.createElement('div');
      centerDiv.className = 'flex gap-4';

      var upDiv = document.createElement('div');
      upDiv.className = 'text-center';
      var upVal = document.createElement('div');
      upVal.className = 'text-lg font-black bet-up';
      upVal.textContent = createTextNode(d.up_predictions || 0) + ' \u2191';
      var upSats = document.createElement('div');
      upSats.className = 'text-[9px] text-slate-500';
      upSats.textContent = createTextNode(((d.up_amount || 0) * 1e8).toFixed(0)) + ' sats';
      upDiv.appendChild(upVal);
      upDiv.appendChild(upSats);

      var downDiv = document.createElement('div');
      downDiv.className = 'text-center';
      var downVal = document.createElement('div');
      downVal.className = 'text-lg font-black bet-down';
      downVal.textContent = createTextNode(d.down_predictions || 0) + ' \u2193';
      var downSats = document.createElement('div');
      downSats.className = 'text-[9px] text-slate-500';
      downSats.textContent = createTextNode(((d.down_amount || 0) * 1e8).toFixed(0)) + ' sats';
      downDiv.appendChild(downVal);
      downDiv.appendChild(downSats);

      centerDiv.appendChild(upDiv);
      centerDiv.appendChild(downDiv);

      // Right: open price
      var rightDiv = document.createElement('div');
      rightDiv.className = 'text-right';
      var priceLabel = document.createElement('div');
      priceLabel.className = 'text-[10px] text-slate-500';
      priceLabel.textContent = 'Open price';
      var priceVal = document.createElement('div');
      priceVal.className = 'text-lg font-black text-white';
      priceVal.textContent = '$' + createTextNode((d.open_price || 0).toLocaleString());
      rightDiv.appendChild(priceLabel);
      rightDiv.appendChild(priceVal);

      row.appendChild(leftDiv);
      row.appendChild(centerDiv);
      row.appendChild(rightDiv);
      el.appendChild(row);

      // Progress bar
      var barOuter = document.createElement('div');
      barOuter.className = 'mt-3 h-1.5 bg-slate-800 rounded-full overflow-hidden';
      var barInner = document.createElement('div');
      barInner.className = 'h-full bg-blue-500 rounded-full transition-all';
      barInner.style.width = Math.max(0, 100 - (timeLeft / 60 * 100)) + '%';
      barOuter.appendChild(barInner);
      el.appendChild(barOuter);
    } else {
      var msg = document.createElement('div');
      msg.className = 'text-center text-slate-500';
      msg.textContent = 'No active round \u2014 settling...';
      el.appendChild(msg);
    }
  } catch (e) {
    var errEl = document.getElementById('live-round');
    errEl.textContent = '';
    var errMsg = document.createElement('div');
    errMsg.className = 'text-center text-red-400';
    errMsg.textContent = 'Error loading round';
    errEl.appendChild(errMsg);
  }
}

// Initial load
loadAgentStatus();
loadLiveRound();

// Auto-refresh
setInterval(loadAgentStatus, 15000);
setInterval(loadLiveRound, 5000);
