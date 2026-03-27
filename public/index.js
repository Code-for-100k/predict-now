// ═══════════════════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════════════════
const API = window.location.origin + '/api';
let authToken = null;
let currentUser = null;
let userBalance = 0;
let currentPage = 'dashboard';
let priceHistory = [];
let allBets = [];
let historyFilter = 'all';
let poolPartyId = '';
let userHasWallet = false;
let userHasDeposited = false;
let userHasBet = false;
let serverFeeRate = 0.10;
let selectedDirection = null; // for bet panel flow
let lastRoundNumber = null; // to detect round settlement
let userMaturityLevel = 'new'; // 'new', 'active', 'experienced'

// ═══════════════════════════════════════════════════════════════════════════
// FIREBASE AUTH
// ═══════════════════════════════════════════════════════════════════════════
async function initApp() {
  try {
    const res = await fetch(`${API}/firebase-config`);
    const cfg = await res.json();
    firebase.initializeApp(cfg);

    firebase.auth().onAuthStateChanged(async (user) => {
      if (user) {
        currentUser = user;
        authToken = await user.getIdToken();
        // Pass invite code if this is a new signup
        const verifyBody = {};
        if (window._pendingInviteCode) {
          verifyBody.invite_code = window._pendingInviteCode;
          window._pendingInviteCode = null;
        }
        try {
          const profile = await apiFetch('/auth/verify', 'POST', verifyBody);
          if (profile.tier) window._userTier = profile.tier;
        } catch(e) {
          console.warn('Backend verify:', e);
          // If invite code is required/invalid, delete the orphaned Firebase user and show error
          if (e.message?.includes('Invite code') || e.message?.includes('invite code')) {
            const errEl = document.getElementById('auth-error');
            errEl.textContent = e.message;
            errEl.classList.remove('hidden');
            try { await user.delete(); } catch(de) { console.warn('Could not delete orphaned user:', de); }
            return;
          }
        }
        showApp();
      } else {
        currentUser = null;
        authToken = null;
        window._userTier = null;
        showLanding();
      }
    });
  } catch(e) { console.error('Init failed:', e); }
}

function showLanding() {
  document.getElementById('landing-screen').classList.remove('page-hidden');
  document.getElementById('auth-screen').classList.add('page-hidden');
  document.getElementById('app-shell').classList.add('page-hidden');
  // Feed live BTC price to landing page
  fetch('/api/btc-price').then(r => r.json()).then(d => {
    if (d.price > 0) {
      document.getElementById('landing-price').textContent = '$' + d.price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    }
  }).catch(() => {});
}

function showAuth() {
  document.getElementById('landing-screen').classList.add('page-hidden');
  document.getElementById('auth-screen').classList.remove('page-hidden');
  document.getElementById('app-shell').classList.add('page-hidden');
  document.getElementById('onboarding-overlay').classList.add('page-hidden');
}

async function showApp() {
  document.getElementById('landing-screen').classList.add('page-hidden');
  document.getElementById('auth-screen').classList.add('page-hidden');
  document.getElementById('app-shell').classList.remove('page-hidden');
  document.getElementById('profile-email').textContent = currentUser?.email || 'User';
  document.getElementById('profile-uid').textContent = currentUser?.uid?.substring(0, 16) + '...';

  await Promise.all([loadBalance(), loadPoolInfo(), checkUserSetup()]);
  startPolling();

  if (!userHasWallet) {
    showOnboarding();
  } else {
    navigateTo('dashboard');
  }
}

// Landing page → Auth screen
document.getElementById('landing-cta').addEventListener('click', () => showAuth());
document.getElementById('landing-cta-bottom').addEventListener('click', () => showAuth());
document.getElementById('landing-login-btn').addEventListener('click', () => showAuth());

// Sign In / Sign Up
document.getElementById('btn-signin').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const pass = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');
  try { await firebase.auth().signInWithEmailAndPassword(email, pass); }
  catch(e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
});
document.getElementById('btn-signup').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const pass = document.getElementById('auth-password').value;
  const inviteCode = document.getElementById('auth-invite-code').value.trim();
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');
  if (!inviteCode) {
    errEl.textContent = 'Invite code is required to create an account';
    errEl.classList.remove('hidden');
    return;
  }
  // Store invite code for the verify call (used in onAuthStateChanged)
  window._pendingInviteCode = inviteCode;
  try { await firebase.auth().createUserWithEmailAndPassword(email, pass); }
  catch(e) {
    window._pendingInviteCode = null;
    errEl.textContent = e.message; errEl.classList.remove('hidden');
  }
});
document.getElementById('btn-logout').addEventListener('click', () => firebase.auth().signOut());

// ═══════════════════════════════════════════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════════════════════════════════════════
async function apiFetch(path, method = 'GET', body = null) {
  if (currentUser) {
    try { authToken = await currentUser.getIdToken(); } catch(e) {}
  }
  const opts = { method, headers: {} };
  if (authToken) opts.headers['Authorization'] = `Bearer ${authToken}`;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// USER MATURITY & ADAPTIVE UI
// ═══════════════════════════════════════════════════════════════════════════
function calculateMaturityLevel() {
  const betsCount = allBets.length;
  if (!userHasWallet && betsCount === 0) {
    userMaturityLevel = 'new';
  } else if (betsCount >= 6) {
    userMaturityLevel = 'experienced';
  } else {
    userMaturityLevel = 'active';
  }
  // Persist
  localStorage.setItem('user_maturity_level', userMaturityLevel);
  localStorage.setItem('bets_placed_count', betsCount);
  localStorage.setItem('has_wallet', userHasWallet ? '1' : '0');
  localStorage.setItem('has_deposited', userHasDeposited ? '1' : '0');
}

function applyMaturityUI() {
  const setupSection = document.getElementById('sidebar-setup');
  const statsSection = document.getElementById('sidebar-stats');
  const getStartedCard = document.getElementById('get-started-card');
  const expStatsBanner = document.getElementById('exp-stats-banner');

  if (userMaturityLevel === 'new') {
    // Show setup progress, show get started card
    setupSection.classList.remove('page-hidden');
    statsSection.classList.add('page-hidden');
    expStatsBanner.classList.add('page-hidden');
    // Get started card shown via updateGetStartedCard()
  } else if (userMaturityLevel === 'active') {
    // Hide onboarding if wallet+deposit done, show small stats
    if (userHasWallet && userHasDeposited) {
      setupSection.classList.add('page-hidden');
      getStartedCard.classList.add('page-hidden');
    }
    statsSection.classList.remove('page-hidden');
    expStatsBanner.classList.add('page-hidden');
    updateSidebarStats();
  } else {
    // Experienced: no onboarding, show portfolio stats prominently
    setupSection.classList.add('page-hidden');
    getStartedCard.classList.add('page-hidden');
    statsSection.classList.remove('page-hidden');
    expStatsBanner.classList.remove('page-hidden');
    updateSidebarStats();
    updateExpStatsBanner();
  }
}

function updateSidebarStats() {
  const settled = allBets.filter(b => b.status !== 'pending');
  const won = settled.filter(b => b.status === 'won');
  const lost = settled.filter(b => b.status === 'lost');
  const totalPnl = won.reduce((s, b) => s + (b.payout_amount || 0), 0) - lost.reduce((s, b) => s + b.amount, 0);
  const winRate = settled.length > 0 ? ((won.length / settled.length) * 100).toFixed(0) : '--';

  document.getElementById('sidebar-winrate').textContent = `${winRate}%`;
  document.getElementById('sidebar-total-bets').textContent = allBets.length;
  const pnlEl = document.getElementById('sidebar-pnl');
  pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}${formatBTC(totalPnl)}`;
  pnlEl.className = `text-xs font-bold ${totalPnl >= 0 ? 'text-tertiary' : 'text-error'}`;

  // Calculate streak
  const streak = calculateStreak();
  const streakEl = document.getElementById('sidebar-streak');
  if (streak.count >= 2) {
    streakEl.classList.remove('page-hidden');
    document.getElementById('sidebar-streak-val').textContent = `${streak.count}${streak.type === 'win' ? 'W' : 'L'}`;
    document.getElementById('sidebar-streak-val').className = `text-xs font-bold ${streak.type === 'win' ? 'text-tertiary' : 'text-error'}`;
  } else {
    streakEl.classList.add('page-hidden');
  }
}

function updateExpStatsBanner() {
  const settled = allBets.filter(b => b.status !== 'pending');
  const won = settled.filter(b => b.status === 'won');
  const lost = settled.filter(b => b.status === 'lost');
  const totalPnl = won.reduce((s, b) => s + (b.payout_amount || 0), 0) - lost.reduce((s, b) => s + b.amount, 0);
  const totalWon = won.reduce((s, b) => s + (b.payout_amount || 0), 0);
  const winRate = settled.length > 0 ? ((won.length / settled.length) * 100).toFixed(0) : '--';

  const pnlEl = document.getElementById('exp-pnl');
  pnlEl.textContent = `${totalPnl >= 0 ? '+' : ''}${formatBTC(totalPnl)} CBTC`;
  pnlEl.className = `text-xl font-black tabular-nums ${totalPnl >= 0 ? 'text-tertiary' : 'text-error'}`;
  document.getElementById('exp-winrate').textContent = `${winRate}%`;
  document.getElementById('exp-total-bets').textContent = allBets.length;
  document.getElementById('exp-total-won').textContent = `${formatBTC(totalWon)} CBTC`;

  // Streak badge
  const streak = calculateStreak();
  const badge = document.getElementById('exp-streak-badge');
  if (streak.count >= 3) {
    badge.classList.remove('page-hidden');
    badge.textContent = `${streak.count}${streak.type === 'win' ? ' Win' : ' Loss'} Streak`;
  } else {
    badge.classList.add('page-hidden');
  }
}

function calculateStreak() {
  const settled = allBets.filter(b => b.status === 'won' || b.status === 'lost');
  if (settled.length === 0) return { count: 0, type: 'none' };
  // Sort by round_number desc
  const sorted = [...settled].sort((a, b) => (b.round_number || 0) - (a.round_number || 0));
  const firstType = sorted[0].status;
  let count = 0;
  for (const b of sorted) {
    if (b.status === firstType) count++;
    else break;
  }
  return { count, type: firstType === 'won' ? 'win' : 'loss' };
}

// ═══════════════════════════════════════════════════════════════════════════
// USER SETUP STATE
// ═══════════════════════════════════════════════════════════════════════════
async function checkUserSetup() {
  try {
    const data = await apiFetch('/auth/verify', 'POST');
    userHasWallet = data.party_ids?.length > 0;
  } catch(e) { userHasWallet = false; }

  userHasDeposited = userBalance > 0;
  userHasBet = allBets.length > 0;

  calculateMaturityLevel();
  updateSetupProgress();
  updateGetStartedCard();
  applyMaturityUI();
}

function updateSetupProgress() {
  const steps = [userHasWallet, userHasDeposited, userHasBet];
  const done = steps.filter(Boolean).length;
  const pct = Math.round((done / 3) * 100);

  const el = document.getElementById('sidebar-setup');
  if (done >= 3 || userMaturityLevel !== 'new') {
    el.classList.add('page-hidden');
    return;
  }
  el.classList.remove('page-hidden');

  document.getElementById('setup-pct').textContent = `${pct}%`;
  document.getElementById('setup-bar').style.width = `${pct}%`;

  ['wallet', 'deposit', 'bet'].forEach((step, i) => {
    const el = document.getElementById(`setup-step-${step}`);
    const isDone = steps[i];
    el.innerHTML = `
      <span class="material-symbols-outlined text-sm ${isDone ? 'text-tertiary' : 'text-slate-600'}" ${isDone ? "style=\"font-variation-settings:'FILL' 1;\"" : ''}>${isDone ? 'check_circle' : 'radio_button_unchecked'}</span>
      <span class="${isDone ? 'text-tertiary' : 'text-slate-500'}">${step === 'wallet' ? 'Link Wallet' : step === 'deposit' ? 'Deposit CBTC' : 'Place First Bet'}</span>
    `;
  });
}

function updateGetStartedCard() {
  const card = document.getElementById('get-started-card');
  if ((userHasWallet && userHasDeposited) || userMaturityLevel === 'experienced') {
    card.classList.add('page-hidden');
    return;
  }
  if (userMaturityLevel === 'active' && userHasWallet && userHasDeposited) {
    card.classList.add('page-hidden');
    return;
  }
  card.classList.remove('page-hidden');

  const gs1 = document.getElementById('gs-step-1');
  const gi1 = document.getElementById('gs-icon-1');
  if (userHasWallet) {
    gs1.className = 'step-done border p-4 transition-all';
    gi1.innerHTML = '<span class="material-symbols-outlined text-tertiary text-sm" style="font-variation-settings:\'FILL\' 1;">check_circle</span>';
  } else {
    gs1.className = 'step-active border p-4 transition-all cursor-pointer hover:border-primary/40 shimmer';
    gi1.innerHTML = '1';
    gi1.className = 'w-7 h-7 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-xs font-bold text-primary';
  }

  const gs2 = document.getElementById('gs-step-2');
  const gi2 = document.getElementById('gs-icon-2');
  if (userHasDeposited) {
    gs2.className = 'step-done border p-4 transition-all';
    gi2.innerHTML = '<span class="material-symbols-outlined text-tertiary text-sm" style="font-variation-settings:\'FILL\' 1;">check_circle</span>';
  } else if (userHasWallet) {
    gs2.className = 'step-active border p-4 transition-all cursor-pointer hover:border-primary/40 shimmer';
    gi2.innerHTML = '2';
    gi2.className = 'w-7 h-7 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-xs font-bold text-primary';
  } else {
    gs2.className = 'step-pending border p-4 transition-all';
    gi2.innerHTML = '2';
    gi2.className = 'w-7 h-7 rounded-full bg-white/5 flex items-center justify-center text-xs font-bold text-slate-500';
  }

  const gs3 = document.getElementById('gs-step-3');
  const gi3 = document.getElementById('gs-icon-3');
  if (userHasDeposited) {
    gs3.className = 'step-active border p-4 transition-all shimmer';
    gi3.innerHTML = '3';
    gi3.className = 'w-7 h-7 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-xs font-bold text-primary';
  }
}

function handleGetStartedStep(step) {
  if (step === 1 && !userHasWallet) {
    showOnboarding();
  } else if (step === 2 && userHasWallet && !userHasDeposited) {
    openDepositDrawer();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD
// ═══════════════════════════════════════════════════════════════════════════
let obStep = 1;

function showOnboarding() {
  obStep = 1;
  document.getElementById('onboarding-overlay').classList.remove('page-hidden');
  updateOnboardingUI();
  if (poolPartyId) document.getElementById('ob-pool-address').textContent = poolPartyId;
}

function hideOnboarding() {
  document.getElementById('onboarding-overlay').classList.add('page-hidden');
  navigateTo('dashboard');
}

function updateOnboardingUI() {
  [1,2,3].forEach(i => {
    document.getElementById(`ob-step-${i}`).classList.toggle('page-hidden', i !== obStep);
    const dot = document.getElementById(`ob-dot-${i}`);
    dot.className = `w-3 h-3 rounded-full transition-all ${i <= obStep ? 'bg-primary' : 'bg-white/10'}`;
  });
  if (obStep >= 2) document.getElementById('ob-line-1').style.width = '100%';
  if (obStep >= 3) document.getElementById('ob-line-2').style.width = '100%';
}

document.getElementById('ob-btn-link').addEventListener('click', async () => {
  const pid = document.getElementById('ob-party-input').value.trim();
  const errEl = document.getElementById('ob-link-error');
  errEl.classList.add('hidden');
  if (!pid) { errEl.textContent = 'Please enter your Canton Party ID'; errEl.classList.remove('hidden'); return; }
  const btn = document.getElementById('ob-btn-link');
  btn.disabled = true; btn.textContent = 'LINKING...';
  try {
    await apiFetch('/auth/link-party', 'POST', { party_id: pid });
    userHasWallet = true;
    updateSetupProgress();
    updateGetStartedCard();
    showToast('Wallet linked successfully!', 'success');
    obStep = 2;
    updateOnboardingUI();
    if (poolPartyId) document.getElementById('ob-pool-address').textContent = poolPartyId;
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'LINK WALLET';
  }
});

document.getElementById('ob-skip').addEventListener('click', hideOnboarding);

document.getElementById('ob-btn-funded').addEventListener('click', () => {
  obStep = 3;
  updateOnboardingUI();
});

document.getElementById('ob-btn-verify').addEventListener('click', async () => {
  const btn = document.getElementById('ob-btn-verify');
  const result = document.getElementById('ob-verify-result');
  btn.disabled = true; btn.textContent = 'CHECKING...';
  try {
    const data = await apiFetch('/deposit', 'POST');
    result.classList.remove('hidden');
    if (data.credited > 0) {
      result.className = 'mb-4 p-4 rounded-sm text-sm bg-tertiary-container/20 border border-tertiary/20 text-tertiary';
      result.innerHTML = `<div class="flex items-center gap-2"><span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1;">check_circle</span> Credited <strong>${formatBTC(data.credited)} CBTC</strong>!</div>`;
      userHasDeposited = true;
      userBalance = data.balance;
      updateSetupProgress();
      updateGetStartedCard();
      loadBalance();
      document.getElementById('ob-btn-finish').classList.remove('page-hidden');
    } else {
      result.className = 'mb-4 p-4 rounded-sm text-sm bg-surface-container-high border border-white/5 text-slate-400';
      result.textContent = data.message || 'No new deposits found. Send CBTC to the pool address first.';
    }
  } catch(e) {
    result.classList.remove('hidden');
    result.className = 'mb-4 p-4 rounded-sm text-sm bg-error-container/20 border border-error/20 text-error';
    result.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'VERIFY DEPOSIT';
  }
});

document.getElementById('ob-btn-finish').addEventListener('click', hideOnboarding);

// Copy helpers
function copyToClipboard(text) {
  if (!text || text === 'Loading...') {
    showToast('Pool address not loaded yet.', 'error');
    return;
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Pool address copied!', 'success');
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Pool address copied!', 'success');
  } catch(e) {
    showToast('Copy failed. Please select and copy manually.', 'error');
  }
  document.body.removeChild(ta);
}

document.getElementById('ob-copy-pool').addEventListener('click', () => copyToClipboard(poolPartyId));

// ═══════════════════════════════════════════════════════════════════════════
// DEPOSIT DRAWER
// ═══════════════════════════════════════════════════════════════════════════
function openDepositDrawer() {
  const drawer = document.getElementById('deposit-drawer');
  drawer.classList.remove('page-hidden');
  document.getElementById('dd-pool-address').textContent = poolPartyId || 'Loading...';
  const noWallet = document.getElementById('dd-no-wallet');
  const verifyBtn = document.getElementById('dd-btn-verify');
  if (!userHasWallet) {
    noWallet.classList.remove('hidden');
    verifyBtn.classList.add('page-hidden');
  } else {
    noWallet.classList.add('hidden');
    verifyBtn.classList.remove('page-hidden');
  }
  document.getElementById('dd-verify-result').classList.add('hidden');
}

function closeDepositDrawer() {
  document.getElementById('deposit-drawer').classList.add('page-hidden');
}

document.getElementById('deposit-drawer-bg').addEventListener('click', closeDepositDrawer);
document.getElementById('deposit-drawer-close').addEventListener('click', closeDepositDrawer);

document.getElementById('dd-btn-verify').addEventListener('click', async () => {
  const btn = document.getElementById('dd-btn-verify');
  const result = document.getElementById('dd-verify-result');
  btn.disabled = true; btn.textContent = 'CHECKING...';
  try {
    const data = await apiFetch('/deposit', 'POST');
    result.classList.remove('hidden');
    if (data.credited > 0) {
      result.className = 'mb-4 p-4 rounded-sm text-sm bg-tertiary-container/20 border border-tertiary/20 text-tertiary';
      result.innerHTML = `<div class="flex items-center gap-2"><span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1;">check_circle</span> Credited <strong>${formatBTC(data.credited)} CBTC</strong>!</div>`;
      userHasDeposited = true;
      updateSetupProgress();
      updateGetStartedCard();
      loadBalance();
      showToast(`+${formatBTC(data.credited)} CBTC deposited!`, 'success');
      document.getElementById('dd-step2-dot').className = 'w-6 h-6 rounded-full bg-tertiary/20 border border-tertiary/40 flex items-center justify-center text-[10px] font-bold text-tertiary';
    } else {
      result.className = 'mb-4 p-4 rounded-sm text-sm bg-surface-container-high border border-white/5 text-slate-400';
      result.textContent = data.message || 'No new deposits found. Send CBTC to the pool address above first.';
    }
  } catch(e) {
    result.classList.remove('hidden');
    result.className = 'mb-4 p-4 rounded-sm text-sm bg-error-container/20 border border-error/20 text-error';
    result.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'VERIFY DEPOSIT';
  }
});

document.getElementById('dd-copy-pool').addEventListener('click', () => copyToClipboard(poolPartyId));
document.getElementById('dd-goto-link').addEventListener('click', () => { closeDepositDrawer(); showOnboarding(); });
document.getElementById('nav-deposit-btn').addEventListener('click', openDepositDrawer);
document.getElementById('sidebar-deposit-btn').addEventListener('click', openDepositDrawer);
document.getElementById('profile-deposit-btn').addEventListener('click', openDepositDrawer);
document.getElementById('profile-copy-pool').addEventListener('click', () => copyToClipboard(poolPartyId));

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════
function navigateTo(page) {
  if (page === 'deposit-mobile') { openDepositDrawer(); return; }
  currentPage = page;
  ['dashboard','history','profile'].forEach(p => {
    document.getElementById(`page-${p}`).classList.toggle('page-hidden', p !== page);
  });
  document.querySelectorAll('.nav-link').forEach(el => {
    const isActive = el.dataset.page === page;
    el.className = `nav-link cursor-pointer text-sm ${isActive ? 'text-amber-500 border-b-2 border-amber-500 pb-0.5' : 'text-slate-400 hover:text-white transition-colors'}`;
  });
  document.querySelectorAll('.side-link').forEach(el => {
    const isActive = el.dataset.page === page;
    el.className = `side-link flex items-center space-x-3 px-4 py-2.5 transition-all duration-200 font-['Inter'] uppercase tracking-widest text-[10px] font-bold cursor-pointer ${isActive ? 'bg-amber-500/10 text-amber-500 border-l-4 border-amber-500' : 'text-slate-500 hover:bg-white/5 hover:text-slate-200'}`;
  });
  document.querySelectorAll('.mobile-nav').forEach(el => {
    const isActive = el.dataset.page === page;
    el.className = `mobile-nav flex flex-col items-center gap-0.5 cursor-pointer ${isActive ? 'text-primary' : 'text-slate-400'}`;
    el.querySelector('.material-symbols-outlined').style.fontVariationSettings = isActive ? "'FILL' 1" : "'FILL' 0";
  });
  if (page === 'history') { loadBets(); loadRoundHistory(); }
  if (page === 'profile') { loadBalance(); loadPoolInfo(); loadUserInfo(); }
}

document.querySelectorAll('.nav-link, .side-link, .mobile-nav').forEach(el => {
  el.addEventListener('click', () => navigateTo(el.dataset.page));
});

// ═══════════════════════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════════════════════
let pollInterval, priceInterval, countdownRAF;

function startPolling() {
  fetchMarketStatus();
  fetchBTCPrice();
  loadBets();
  loadRecentOutcomes();

  pollInterval = setInterval(fetchMarketStatus, 3000);
  initTVChart();
  connectBTCWebSocket();
  fetchBTCPrice();
  setInterval(updateCountdown, 100);
  setInterval(() => { loadBets(); loadBalance(); checkUserSetup(); }, 15000);
}

// ═══════════════════════════════════════════════════════════════════════════
// BTC PRICE (SINGLE SOURCE)
// ═══════════════════════════════════════════════════════════════════════════
let lastBTCPrice = 0;
let btcPriceUpdatedAt = 0;
let btcWs = null;
let wsReconnectTimer = null;

// TradingView Lightweight Chart
let tvChart = null;
let tvLineSeries = null;
let tvLockPriceLine = null;

function initTVChart() {
  const container = document.getElementById('tv-chart-container');
  if (!container || !window.LightweightCharts) return;

  tvChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 300,
    layout: {
      background: { type: 'solid', color: '#10131c' },
      textColor: '#8b8fa3',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.03)' },
      horzLines: { color: 'rgba(255,255,255,0.03)' },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Magnet },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.1)',
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.1)',
      timeVisible: true,
      secondsVisible: false,
    },
    handleScroll: false,
    handleScale: false,
  });

  tvLineSeries = tvChart.addLineSeries({
    color: '#ffc174',
    lineWidth: 2,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    priceLineVisible: false,
    lastValueVisible: true,
  });

  const ro = new ResizeObserver(() => {
    if (tvChart) tvChart.applyOptions({ width: container.clientWidth });
  });
  ro.observe(container);
}

function updateTVChart(price) {
  if (!tvLineSeries) return;
  const now = Math.floor(Date.now() / 1000);
  tvLineSeries.update({ time: now, value: price });
}

function setTVLockPriceLine(lockPrice) {
  if (!tvLineSeries || !lockPrice || lockPrice <= 0) return;
  if (tvLockPriceLine) {
    tvLineSeries.removePriceLine(tvLockPriceLine);
    tvLockPriceLine = null;
  }
  tvLockPriceLine = tvLineSeries.createPriceLine({
    price: lockPrice,
    color: '#56e5a9',
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title: 'Lock',
  });
}

// Binance WebSocket
function connectBTCWebSocket() {
  if (btcWs && btcWs.readyState <= 1) return;
  try {
    btcWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
    btcWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const price = parseFloat(data.p);
        if (!price || isNaN(price)) return;
        updateBTCPriceDisplay(price);
      } catch(e) {}
    };
    btcWs.onopen = () => {
      console.log('Binance WS connected');
      document.getElementById('btc-change').textContent = 'LIVE';
      document.getElementById('btc-change').className = 'text-[9px] font-bold uppercase tracking-widest text-tertiary';
      const mobileChange = document.getElementById('btc-change-mobile');
      if (mobileChange) { mobileChange.textContent = 'LIVE'; mobileChange.className = 'text-[9px] font-bold uppercase tracking-widest text-tertiary'; }
    };
    btcWs.onclose = () => {
      console.warn('Binance WS closed, reconnecting in 3s...');
      wsReconnectTimer = setTimeout(connectBTCWebSocket, 3000);
    };
    btcWs.onerror = (e) => {
      console.warn('Binance WS error:', e);
      btcWs.close();
    };
  } catch(e) {
    console.warn('WebSocket init failed, falling back to REST:', e);
    if (!connectBTCWebSocket._restFallback) {
      connectBTCWebSocket._restFallback = setInterval(fetchBTCPrice, 5000);
    }
  }
}

// Single price display update function (ONE SOURCE)
function updateBTCPriceDisplay(price) {
  const formatted = '$' + price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

  // Desktop price in top bar
  const priceEl = document.getElementById('btc-price');
  priceEl.textContent = formatted;

  // Mobile price
  const mobilePriceEl = document.getElementById('btc-price-mobile');
  if (mobilePriceEl) mobilePriceEl.textContent = formatted;

  // Mobile current price
  const mobileCurrentEl = document.getElementById('current-price-mobile');
  if (mobileCurrentEl) mobileCurrentEl.textContent = formatted;

  // Flash color on price change
  if (lastBTCPrice > 0 && price !== lastBTCPrice) {
    const color = price > lastBTCPrice ? 'text-tertiary' : 'text-error';
    priceEl.className = `text-base font-black tracking-tight tabular-nums ${color}`;
    clearTimeout(priceEl._resetTimer);
    priceEl._resetTimer = setTimeout(() => {
      priceEl.className = 'text-base font-black text-on-surface tracking-tight tabular-nums';
    }, 400);
  }

  lastBTCPrice = price;

  // Update lock vs current comparison
  if (marketData && marketData.status === 'active' && marketData.open_price) {
    updatePriceComparison(marketData.open_price);
  }

  // Throttle chart updates to ~1/sec
  const now = Date.now();
  if (!updateBTCPriceDisplay._lastBar || now - updateBTCPriceDisplay._lastBar > 1000) {
    updateBTCPriceDisplay._lastBar = now;
    priceHistory.push(price);
    if (priceHistory.length > 30) priceHistory.shift();
    updateTVChart(price);
  }
}

// Fallback: server-side cached price
async function fetchBTCPrice() {
  try {
    const res = await fetch('/api/btc-price');
    const data = await res.json();
    if (!data.price || data.price === 0) return;
    updateBTCPriceDisplay(data.price);
    if (data.change_24h !== undefined) {
      const changeEl = document.getElementById('btc-change');
      const sign = data.change_24h >= 0 ? '+' : '';
      changeEl.textContent = `${sign}${data.change_24h.toFixed(2)}% 24H`;
      changeEl.className = `text-[9px] font-bold uppercase tracking-widest ${data.change_24h >= 0 ? 'text-tertiary' : 'text-error'}`;
      const mobileChange = document.getElementById('btc-change-mobile');
      if (mobileChange) {
        mobileChange.textContent = changeEl.textContent;
        mobileChange.className = changeEl.className;
      }
    }
  } catch(e) { console.warn('Price fetch:', e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRICE COMPARISON (Lock vs Current) — reads from lastBTCPrice
// ═══════════════════════════════════════════════════════════════════════════
function updatePriceComparison(lockPrice) {
  const priceDiffEl = document.getElementById('price-diff');
  const priceDiffMobileEl = document.getElementById('price-diff-mobile');

  if (!lastBTCPrice || lastBTCPrice === 0) {
    priceDiffEl.textContent = '--';
    priceDiffEl.className = 'text-sm font-bold tabular-nums';
    if (priceDiffMobileEl) { priceDiffMobileEl.textContent = '--'; priceDiffMobileEl.className = 'text-sm font-bold tabular-nums'; }
    return;
  }

  if (lockPrice && lockPrice > 0) {
    const diff = lastBTCPrice - lockPrice;
    const pctDiff = ((diff / lockPrice) * 100).toFixed(2);
    const sign = diff >= 0 ? '+' : '';
    const text = `${sign}${pctDiff}%`;
    const cls = `text-sm font-bold tabular-nums ${diff > 0 ? 'text-bull' : diff < 0 ? 'text-bear' : 'text-on-surface'}`;
    priceDiffEl.textContent = text;
    priceDiffEl.className = cls;
    if (priceDiffMobileEl) { priceDiffMobileEl.textContent = text; priceDiffMobileEl.className = cls; }
  } else {
    priceDiffEl.textContent = '--';
    priceDiffEl.className = 'text-sm font-bold tabular-nums';
    if (priceDiffMobileEl) { priceDiffMobileEl.textContent = '--'; priceDiffMobileEl.className = 'text-sm font-bold tabular-nums'; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET STATUS
// ═══════════════════════════════════════════════════════════════════════════
let marketData = null;
async function fetchMarketStatus() {
  try {
    const data = await apiFetch('/market/status');
    const prevData = marketData;
    marketData = data;
    const statusLabel = document.getElementById('market-status-label');
    const dot = document.getElementById('market-dot');
    const dotChart = document.getElementById('market-dot-chart');

    if (data.status === 'active') {
      statusLabel.textContent = 'LIVE';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-tertiary animate-pulse';
      if (dotChart) dotChart.className = 'w-1.5 h-1.5 rounded-full bg-tertiary animate-pulse';
      document.getElementById('round-id').textContent = `#${data.round_number}`;
      document.getElementById('active-round-label').textContent = `Round #${data.round_number}`;

      if (data.fee_percentage !== undefined) {
        serverFeeRate = data.fee_percentage / 100;
      }

      // Lock price
      const lockPriceEl = document.getElementById('lock-price');
      const lockPriceMobileEl = document.getElementById('lock-price-mobile');
      if (data.open_price) {
        const lockFormatted = '$' + data.open_price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        lockPriceEl.textContent = lockFormatted;
        if (lockPriceMobileEl) lockPriceMobileEl.textContent = lockFormatted;
        setTVLockPriceLine(data.open_price);
      } else {
        lockPriceEl.textContent = '--';
        if (lockPriceMobileEl) lockPriceMobileEl.textContent = '--';
      }

      updatePriceComparison(data.open_price);

      const totalVol = formatBTC(data.up_amount + data.down_amount);
      document.getElementById('round-volume').textContent = `${totalVol} CBTC`;
      const total = data.up_amount + data.down_amount;
      const bullPct = total > 0 ? Math.round((data.up_amount / total) * 100) : 50;
      const bearPct = 100 - bullPct;
      document.getElementById('bull-pct').textContent = `BULLS ${bullPct}%`;
      document.getElementById('bear-pct').textContent = `BEARS ${bearPct}%`;
      document.getElementById('bull-bar').style.width = `${bullPct}%`;
      document.getElementById('bear-bar').style.width = `${bearPct}%`;

      const fee = serverFeeRate;
      const upMult = total > 0 && data.up_amount > 0 ? ((total * (1 - fee)) / data.up_amount).toFixed(2) : '--';
      const downMult = total > 0 && data.down_amount > 0 ? ((total * (1 - fee)) / data.down_amount).toFixed(2) : '--';
      document.getElementById('up-multiplier').textContent = `${upMult}x`;
      document.getElementById('down-multiplier').textContent = `${downMult}x`;
      document.getElementById('up-pool').textContent = `${formatBTC(data.up_amount)} CBTC`;
      document.getElementById('down-pool').textContent = `${formatBTC(data.down_amount)} CBTC`;
      document.getElementById('btn-up').disabled = false;
      document.getElementById('btn-down').disabled = false;

      // Detect round settlement (round number changed)
      if (lastRoundNumber !== null && data.round_number !== lastRoundNumber) {
        onRoundSettled(prevData);
      }
      lastRoundNumber = data.round_number;

    } else {
      statusLabel.textContent = 'BETWEEN ROUNDS';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-slate-500';
      if (dotChart) dotChart.className = 'w-1.5 h-1.5 rounded-full bg-slate-500';
      document.getElementById('countdown').textContent = 'NEXT...';
      document.getElementById('btn-up').disabled = true;
      document.getElementById('btn-down').disabled = true;
      document.getElementById('lock-price').textContent = '--';
      const lockPriceMobileEl = document.getElementById('lock-price-mobile');
      if (lockPriceMobileEl) lockPriceMobileEl.textContent = '--';
      document.getElementById('price-diff').textContent = '--';
      document.getElementById('price-diff').className = 'text-sm font-bold tabular-nums';
      const priceDiffMobileEl = document.getElementById('price-diff-mobile');
      if (priceDiffMobileEl) { priceDiffMobileEl.textContent = '--'; priceDiffMobileEl.className = 'text-sm font-bold tabular-nums'; }
    }
  } catch(e) { console.warn('Market status:', e); }
}

function updateCountdown() {
  if (!marketData || marketData.status !== 'active') return;
  const el = document.getElementById('countdown');
  const remaining = marketData.window_end_ms - Date.now();
  if (remaining <= 0) {
    el.textContent = 'SETTLING';
    el.className = 'text-5xl md:text-7xl font-black text-primary tracking-tighter tabular-nums pulse-glow';
    return;
  }
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  el.className = `text-5xl md:text-7xl font-black tracking-tighter tabular-nums ${remaining < 10000 ? 'countdown-urgent' : 'text-on-surface'}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUND SETTLED ANIMATION
// ═══════════════════════════════════════════════════════════════════════════
function onRoundSettled(prevData) {
  // Load fresh bets & outcomes
  loadBets();
  loadRecentOutcomes();
  loadBalance();

  // Check if user had a bet in the previous round
  const prevRound = prevData?.round_number;
  if (!prevRound) return;

  // Brief delay to let bets load, then show overlay
  setTimeout(() => {
    const userBet = allBets.find(b => b.round_number === prevRound && (b.status === 'won' || b.status === 'lost'));
    if (userBet) {
      showSettledOverlay(userBet.status === 'won', userBet);
    } else {
      // Show generic round settled
      showSettledOverlay(null, null);
    }
  }, 1500);
}

function showSettledOverlay(isWinner, bet) {
  const overlay = document.getElementById('settled-overlay');
  const icon = document.getElementById('settled-icon');
  const title = document.getElementById('settled-title');
  const subtitle = document.getElementById('settled-subtitle');

  if (isWinner === true) {
    icon.textContent = 'You Won!';
    icon.className = 'text-5xl mb-2 font-black text-tertiary';
    title.textContent = `+${formatBTC(bet.payout_amount || 0)} CBTC`;
    title.className = 'text-3xl font-black text-tertiary mb-2';
    subtitle.textContent = `Round #${bet.round_number} settled`;
    fireConfetti();
  } else if (isWinner === false) {
    icon.textContent = 'Round Lost';
    icon.className = 'text-5xl mb-2 font-black text-error';
    title.textContent = `-${formatBTC(bet.amount)} CBTC`;
    title.className = 'text-3xl font-black text-error mb-2';
    subtitle.textContent = `Round #${bet.round_number} settled`;
  } else {
    icon.textContent = 'Round Settled';
    icon.className = 'text-5xl mb-2 font-black text-primary';
    title.textContent = 'New Round Starting';
    title.className = 'text-3xl font-black text-on-surface mb-2';
    subtitle.textContent = '';
  }

  overlay.classList.remove('page-hidden');
  setTimeout(() => {
    overlay.classList.add('page-hidden');
  }, 3000);
}

// Simple confetti
function fireConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#22c55e', '#ffc174', '#56e5a9', '#f59e0b', '#d0bcff'];

  for (let i = 0; i < 80; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 100,
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * 3 + 2,
      size: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.2,
      life: 1,
    });
  }

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.rotation += p.rotSpeed;
      p.life -= 0.008;
      if (p.life <= 0) return;
      alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    frame++;
    if (alive && frame < 180) requestAnimationFrame(animate);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  animate();
}

// ═══════════════════════════════════════════════════════════════════════════
// BALANCE
// ═══════════════════════════════════════════════════════════════════════════
async function loadBalance() {
  try {
    const data = await apiFetch('/balance');
    userBalance = data.balance;
    document.getElementById('nav-balance').textContent = `${formatBTC(data.balance)} CBTC`;
    document.getElementById('wallet-balance').innerHTML = `${formatBTC(data.balance)} <span class="text-slate-500 text-lg font-normal">CBTC</span>`;
    document.getElementById('wallet-deposited').textContent = `${formatBTC(data.total_deposited || 0)} CBTC`;
    document.getElementById('wallet-withdrawn').textContent = `${formatBTC(data.total_withdrawn || 0)} CBTC`;
    document.getElementById('profile-won').textContent = `${formatBTC(data.total_won || 0)} CBTC`;
    document.getElementById('profile-lost').textContent = `${formatBTC(data.total_lost || 0)} CBTC`;
    if (data.total_deposited > 0) userHasDeposited = true;
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// BETS
// ═══════════════════════════════════════════════════════════════════════════
async function loadBets() {
  try {
    allBets = await apiFetch('/bets');
    if (allBets.length > 0) userHasBet = true;
    renderActiveBets();
    renderHistoryBets();
    renderBetStats();
    // Recalculate maturity
    calculateMaturityLevel();
    applyMaturityUI();
  } catch(e) {}
}

function renderActiveBets() {
  const body = document.getElementById('active-bets-body');
  const pending = allBets.filter(b => b.status === 'pending');
  if (!pending.length) {
    body.innerHTML = '<tr><td colspan="4" class="px-6 py-5 text-center text-slate-500 text-sm">No active bets</td></tr>';
    return;
  }
  body.innerHTML = pending.map(b => `
    <tr class="hover:bg-white/5 transition-colors">
      <td class="px-4 md:px-6 py-4"><div class="flex items-center space-x-2">
        <span class="material-symbols-outlined text-${b.direction === 'UP' ? 'bull' : 'bear'} text-sm" style="font-variation-settings:'FILL' 1;">${b.direction === 'UP' ? 'trending_up' : 'trending_down'}</span>
        <span class="text-xs font-bold text-on-surface uppercase tracking-widest">${b.direction}</span>
      </div></td>
      <td class="px-4 md:px-6 py-4 text-sm font-bold text-on-surface tabular-nums">${formatBTC(b.amount)} CBTC</td>
      <td class="px-4 md:px-6 py-4 text-sm font-medium text-slate-400">#${b.round_number || '--'}</td>
      <td class="px-4 md:px-6 py-4"><span class="px-2 py-0.5 bg-surface-container-highest text-slate-300 text-[10px] font-black uppercase tracking-widest rounded-full">Pending</span></td>
    </tr>`).join('');
}

function renderHistoryBets() {
  const body = document.getElementById('history-bets-body');
  let filtered = allBets;
  if (historyFilter !== 'all') filtered = allBets.filter(b => b.status === historyFilter);
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="5" class="px-6 py-6 text-center text-slate-500 text-sm">No ${historyFilter === 'all' ? '' : historyFilter} bets found</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(b => {
    const statusClass = b.status === 'won' ? 'bg-tertiary-container/20 text-tertiary border border-tertiary/20' :
                        b.status === 'lost' ? 'bg-error-container/20 text-error border border-error/20' :
                        'bg-surface-container-highest text-slate-300';
    const paidBadge = b.payout_txn_id ? ' <span class="ml-1 px-1.5 py-0.5 bg-tertiary/20 text-tertiary text-[8px] font-black rounded-full">PAID</span>' : '';
    return `
    <tr class="hover:bg-white/[0.02] transition-colors">
      <td class="px-4 md:px-6 py-4 font-mono text-sm text-on-surface">#${b.round_number || '--'}</td>
      <td class="px-4 md:px-6 py-4"><div class="flex items-center space-x-2">
        <span class="material-symbols-outlined text-${b.direction === 'UP' ? 'bull' : 'bear'} text-sm" style="font-variation-settings:'FILL' 1;">${b.direction === 'UP' ? 'trending_up' : 'trending_down'}</span>
        <span class="text-xs font-bold uppercase">${b.direction}</span>
      </div></td>
      <td class="px-4 md:px-6 py-4 font-mono text-sm text-on-surface tabular-nums">${formatBTC(b.amount)}</td>
      <td class="px-4 md:px-6 py-4 font-mono text-sm ${b.status === 'won' ? 'text-tertiary' : b.status === 'lost' ? 'text-error' : 'text-slate-500'} tabular-nums">${b.status === 'won' ? '+' + formatBTC(b.payout_amount || 0) : b.status === 'lost' ? '-' + formatBTC(b.amount) : '--'}</td>
      <td class="px-4 md:px-6 py-4"><span class="px-2 py-0.5 ${statusClass} text-[10px] font-black uppercase tracking-widest rounded-full">${b.status}</span>${paidBadge}</td>
    </tr>`;
  }).join('');
}

function renderBetStats() {
  const settled = allBets.filter(b => b.status !== 'pending');
  const won = settled.filter(b => b.status === 'won');
  const lost = settled.filter(b => b.status === 'lost');
  const totalPnl = won.reduce((s, b) => s + (b.payout_amount || 0), 0) - lost.reduce((s, b) => s + b.amount, 0);
  const winRate = settled.length > 0 ? ((won.length / settled.length) * 100).toFixed(1) : '--';
  document.getElementById('stats-pnl').textContent = `${totalPnl >= 0 ? '+' : ''}${formatBTC(totalPnl)} CBTC`;
  document.getElementById('stats-pnl').className = `text-2xl font-bold ${totalPnl >= 0 ? 'text-tertiary' : 'text-error'}`;
  document.getElementById('stats-winrate').textContent = `${winRate}%`;
  document.getElementById('stats-total-bets').textContent = allBets.length;
  document.getElementById('profile-winrate').textContent = `${winRate}%`;
  document.getElementById('profile-winrate-bar').style.width = `${winRate === '--' ? 0 : winRate}%`;
}

document.querySelectorAll('.history-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    historyFilter = btn.dataset.filter;
    document.querySelectorAll('.history-filter').forEach(b => {
      b.className = `history-filter px-4 py-1.5 rounded-sm text-[10px] font-bold uppercase tracking-wider ${b.dataset.filter === historyFilter ? 'bg-primary-container text-on-primary-fixed' : 'bg-surface-container-high text-slate-400 hover:text-white transition-colors'}`;
    });
    renderHistoryBets();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUND HISTORY
// ═══════════════════════════════════════════════════════════════════════════
async function loadRoundHistory() {
  try {
    const data = await apiFetch('/results/history?limit=20');
    const body = document.getElementById('round-history-body');
    if (!data.rounds?.length) {
      body.innerHTML = '<tr><td colspan="5" class="px-6 py-6 text-center text-slate-500 text-sm">No settled rounds yet</td></tr>';
      return;
    }
    body.innerHTML = data.rounds.map(r => `
      <tr class="hover:bg-white/[0.02] transition-colors">
        <td class="px-4 md:px-6 py-4 font-mono text-sm text-on-surface">#${r.round_number}</td>
        <td class="px-4 md:px-6 py-4 font-mono text-sm text-on-surface tabular-nums">$${(r.open_price || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
        <td class="px-4 md:px-6 py-4 font-mono text-sm ${r.winning_direction === 'UP' ? 'text-bull' : 'text-bear'} tabular-nums">$${(r.close_price || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
        <td class="px-4 md:px-6 py-4 text-center"><span class="material-symbols-outlined text-${r.winning_direction === 'UP' ? 'bull' : 'bear'}" style="font-variation-settings:'FILL' 1;">${r.winning_direction === 'UP' ? 'trending_up' : 'trending_down'}</span></td>
        <td class="px-4 md:px-6 py-4 font-mono text-sm text-on-surface tabular-nums">${formatBTC(r.total_up_amount + r.total_down_amount)}</td>
      </tr>`).join('');
  } catch(e) { console.warn('Round history:', e); }
}

async function loadRecentOutcomes() {
  try {
    const data = await apiFetch('/results/history?limit=5');
    const container = document.getElementById('recent-outcomes');
    if (!data.rounds?.length) {
      container.innerHTML = '<div class="text-sm text-slate-500 text-center py-6">No rounds settled yet</div>';
      return;
    }
    container.innerHTML = data.rounds.map(r => {
      const isUp = r.winning_direction === 'UP';
      return `<div class="flex items-center justify-between px-4 md:px-6 py-3 hover:bg-white/[0.02] transition-colors">
        <div class="flex items-center gap-3">
          <span class="material-symbols-outlined text-${isUp ? 'bull' : 'bear'} text-lg" style="font-variation-settings:'FILL' 1;">${isUp ? 'trending_up' : 'trending_down'}</span>
          <div>
            <span class="text-[10px] font-bold text-slate-500 uppercase block">#${r.round_number}</span>
            <span class="text-xs font-bold text-on-surface tabular-nums">$${(r.close_price || 0).toLocaleString()}</span>
          </div>
        </div>
        <div class="text-right">
          <span class="text-[10px] font-bold ${isUp ? 'text-bull' : 'text-bear'} uppercase">${isUp ? 'UP' : 'DOWN'}</span>
          <span class="text-[9px] text-slate-500 block tabular-nums">${formatBTC(r.total_up_amount + r.total_down_amount)} pool</span>
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.warn('Recent outcomes:', e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// BETTING — PancakeSwap-style flow: click UP/DOWN first, THEN enter amount
// ═══════════════════════════════════════════════════════════════════════════
function selectDirection(direction) {
  // Smart prompts
  if (!userHasWallet) {
    showToast('Link your Canton wallet first', 'error');
    showOnboarding();
    return;
  }
  if (userBalance <= 0) {
    showToast('Deposit CBTC to start betting', 'error');
    openDepositDrawer();
    return;
  }
  if (!marketData || marketData.status !== 'active') {
    showToast('Wait for an active round', 'error');
    return;
  }

  selectedDirection = direction;
  const panel = document.getElementById('bet-panel');
  panel.classList.remove('page-hidden');

  const label = document.getElementById('bet-direction-label');
  const icon = document.getElementById('bet-direction-icon');
  const confirmBtn = document.getElementById('btn-confirm-bet');

  if (direction === 'UP') {
    label.textContent = 'Predict UP';
    label.className = 'text-sm font-black uppercase text-bull';
    icon.textContent = 'trending_up';
    icon.className = 'material-symbols-outlined text-bull text-base';
    confirmBtn.className = 'w-full mt-4 py-3 font-black text-base uppercase tracking-widest rounded-lg transition-all active:scale-95 btn-up-big text-white';
  } else {
    label.textContent = 'Predict DOWN';
    label.className = 'text-sm font-black uppercase text-bear';
    icon.textContent = 'trending_down';
    icon.className = 'material-symbols-outlined text-bear text-base';
    confirmBtn.className = 'w-full mt-4 py-3 font-black text-base uppercase tracking-widest rounded-lg transition-all active:scale-95 btn-down-big text-white';
  }

  // Scroll to bet panel
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeBetPanel() {
  document.getElementById('bet-panel').classList.add('page-hidden');
  selectedDirection = null;
}

// Confirm bet button
document.getElementById('btn-confirm-bet').addEventListener('click', () => {
  if (!selectedDirection) return;
  placeBet(selectedDirection);
});

async function placeBet(direction) {
  if (!userHasWallet) {
    showToast('Link your Canton wallet first', 'error');
    showOnboarding();
    return;
  }
  if (userBalance <= 0) {
    showToast('Deposit CBTC to start betting', 'error');
    openDepositDrawer();
    return;
  }

  const amount = parseFloat(document.getElementById('bet-amount').value);
  if (isNaN(amount) || amount < 0.0000001) { showToast('Min bet: 0.0000001 CBTC (10 sats)', 'error'); return; }
  if (amount > userBalance) { showToast(`Insufficient balance (${formatBTC(userBalance)} CBTC)`, 'error'); openDepositDrawer(); return; }

  try {
    const confirmBtn = document.getElementById('btn-confirm-bet');
    confirmBtn.disabled = true; confirmBtn.textContent = 'PLACING...';
    const data = await apiFetch('/predict', 'POST', { direction, amount });
    showToast(`${direction} bet placed: ${formatBTC(amount)} CBTC on Round #${data.market_round}`, 'success');
    userHasBet = true;
    closeBetPanel();
    document.getElementById('bet-amount').value = '';
    updateSliderVisual(0);
    updateBetSatsDisplay();
    updateSetupProgress();
    updateGetStartedCard();
    loadBalance();
    loadBets();
    fetchMarketStatus();
  } catch(e) {
    showToast(e.message, 'error');
  } finally {
    const confirmBtn = document.getElementById('btn-confirm-bet');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Confirm Prediction';
  }
}

// formatBTC
function formatBTC(amount) {
  if (amount === 0) return '0';
  if (Math.abs(amount) < 0.001) return parseFloat(amount.toFixed(8)).toString();
  if (Math.abs(amount) < 1) return parseFloat(amount.toFixed(8)).toString();
  return parseFloat(amount.toFixed(8)).toString();
}

// Sats display
function toSats(btc) {
  return Math.round(btc * 1e8);
}

function updateBetSatsDisplay() {
  const val = parseFloat(document.getElementById('bet-amount').value) || 0;
  const sats = toSats(val);
  document.getElementById('bet-sats-display').textContent = sats.toLocaleString() + ' sats';
}

function setBetFromPct(pct) {
  const amount = Math.floor(userBalance * (pct / 100) * 1e8) / 1e8;
  document.getElementById('bet-amount').value = amount > 0 ? formatBTC(amount) : '0';
  updateSliderVisual(pct);
  updateBetSatsDisplay();
  document.querySelectorAll('.bet-pct-btn').forEach(b => {
    const bPct = parseInt(b.dataset.pct);
    if (bPct === pct) {
      b.classList.add('border-primary', 'text-primary');
      b.classList.remove('border-transparent', 'text-slate-400');
    } else {
      b.classList.remove('border-primary', 'text-primary');
      b.classList.add('border-transparent', 'text-slate-400');
    }
  });
}

function updateSliderVisual(pct) {
  document.getElementById('bet-slider').value = pct;
  document.getElementById('bet-slider-fill').style.width = pct + '%';
  document.getElementById('bet-slider-thumb').style.left = pct + '%';
  document.querySelectorAll('[data-pct]').forEach(dot => {
    if (dot.tagName === 'BUTTON') return;
    const dotPct = parseInt(dot.dataset.pct);
    if (dotPct <= pct) {
      dot.classList.remove('border-slate-600', 'bg-surface-container-highest');
      dot.classList.add('border-primary', 'bg-primary');
    } else {
      dot.classList.add('border-slate-600', 'bg-surface-container-highest');
      dot.classList.remove('border-primary', 'bg-primary');
    }
  });
}

document.querySelectorAll('.bet-pct-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const pct = parseInt(btn.dataset.pct);
    setBetFromPct(pct);
  });
});

document.getElementById('bet-slider').addEventListener('input', (e) => {
  const pct = parseInt(e.target.value);
  const amount = Math.floor(userBalance * (pct / 100) * 1e8) / 1e8;
  document.getElementById('bet-amount').value = amount > 0 ? formatBTC(amount) : '0';
  updateSliderVisual(pct);
  updateBetSatsDisplay();
  document.querySelectorAll('.bet-pct-btn').forEach(b => {
    b.classList.remove('border-primary', 'text-primary');
    b.classList.add('border-transparent', 'text-slate-400');
  });
});

document.getElementById('bet-amount').addEventListener('input', () => {
  const val = parseFloat(document.getElementById('bet-amount').value) || 0;
  const pct = userBalance > 0 ? Math.min(100, Math.round((val / userBalance) * 100)) : 0;
  updateSliderVisual(pct);
  updateBetSatsDisplay();
  document.querySelectorAll('.bet-pct-btn').forEach(b => {
    b.classList.remove('border-primary', 'text-primary');
    b.classList.add('border-transparent', 'text-slate-400');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WALLET / PROFILE
// ═══════════════════════════════════════════════════════════════════════════
async function loadPoolInfo() {
  try {
    const data = await apiFetch('/pool-info');
    poolPartyId = data.pool_party_id;
    document.getElementById('pool-party-id').textContent = poolPartyId;
    document.getElementById('ob-pool-address').textContent = poolPartyId;
    document.getElementById('dd-pool-address').textContent = poolPartyId;
  } catch(e) {}
}

async function loadUserInfo() {
  try {
    const data = await apiFetch('/auth/verify', 'POST');
    userHasWallet = data.party_ids?.length > 0;
    if (data.party_ids?.length) {
      const wallets = data.party_ids.map((pid, i) => {
        const isActive = pid === data.active_party_id;
        return `<div class="flex items-center justify-between p-3 bg-surface-container-highest/30 border-l-2 ${isActive ? 'border-primary' : 'border-white/10'}">
          <div class="flex-1 min-w-0 mr-3">
            <span class="text-[10px] font-mono text-slate-400 break-all">${pid.substring(0, 40)}...</span>
            ${isActive ? '<span class="ml-2 px-1.5 py-0.5 bg-primary/20 text-primary text-[8px] font-black rounded-full">ACTIVE</span>' : ''}
          </div>
          ${!isActive ? `<button class="set-active-btn px-2 py-1 text-[10px] font-bold text-slate-500 uppercase tracking-widest hover:text-primary transition-colors" data-pid="${pid}">Set Active</button>` : ''}
        </div>`;
      }).join('');
      document.getElementById('linked-wallets').innerHTML = wallets;
      document.querySelectorAll('.set-active-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await apiFetch('/auth/set-active-wallet', 'POST', { party_id: btn.dataset.pid });
            loadUserInfo();
            showToast('Active wallet updated', 'success');
          } catch(e) { showToast(e.message, 'error'); }
        });
      });
    } else {
      document.getElementById('linked-wallets').innerHTML = '<div class="text-sm text-slate-500">No wallets linked yet.</div>';
    }
  } catch(e) {}
}

document.getElementById('btn-link-wallet').addEventListener('click', async () => {
  const pid = document.getElementById('link-party-input').value.trim();
  if (!pid) return;
  try {
    await apiFetch('/auth/link-party', 'POST', { party_id: pid });
    document.getElementById('link-party-input').value = '';
    userHasWallet = true;
    updateSetupProgress();
    updateGetStartedCard();
    showToast('Wallet linked successfully!', 'success');
    loadUserInfo();
    loadBalance();
  } catch(e) { showToast(e.message, 'error'); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const colors = {
    success: 'bg-tertiary-container/90 border-tertiary text-tertiary',
    error: 'bg-error-container/90 border-error text-error',
    info: 'bg-surface-container-high/90 border-primary text-primary'
  };
  const icons = { success: 'check_circle', error: 'error', info: 'info' };

  const toast = document.createElement('div');
  toast.className = `pointer-events-auto flex items-center gap-3 p-3 border-l-4 backdrop-blur-xl shadow-2xl ${colors[type] || colors.info} text-sm font-bold fade-in max-w-sm`;
  const iconSpan = document.createElement('span');
  iconSpan.className = 'material-symbols-outlined text-lg';
  iconSpan.style.fontVariationSettings = "'FILL' 1";
  iconSpan.textContent = icons[type] || icons.info;
  const msgSpan = document.createElement('span');
  msgSpan.className = 'flex-1';
  msgSpan.textContent = msg;
  toast.appendChild(iconSpan);
  toast.appendChild(msgSpan);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// MUSIC PLAYER
// ═══════════════════════════════════════════════════════════════════════════
let musicPlaying = false;
function toggleMusic() {
  const audio = document.getElementById('music-audio');
  const bars = document.getElementById('music-bars');
  const label = document.getElementById('music-label');
  if (musicPlaying) {
    audio.pause();
    bars.classList.remove('playing');
    label.textContent = 'Synthwave';
    label.className = 'text-[10px] font-bold text-slate-500 uppercase tracking-widest';
  } else {
    audio.volume = 0.3;
    audio.play().catch(() => {});
    bars.classList.add('playing');
    label.textContent = 'Playing';
    label.className = 'text-[10px] font-bold text-amber-500 uppercase tracking-widest';
  }
  musicPlaying = !musicPlaying;
}

// ═══ COPY TRADING ═══
let copyModalAgentUid = null;

async function loadPublicAgents() {
  const section = document.getElementById('copy-trading-section');
  try {
    const res = await fetch('/api/agents/public');
    const data = await res.json();
    const agents = data.agents || [];
    if (agents.length === 0) return;

    section.style.display = '';
    const container = document.getElementById('agent-cards-container');

    // Check current copy status
    let copyStatus = null;
    if (currentUser) {
      try {
        const sr = await apiFetch('/copy-status', 'GET');
        copyStatus = sr;
      } catch (e) {}
    }

    container.innerHTML = agents.map(a => {
      const wrClass = a.win_rate >= 50 ? 'text-green-400' : a.win_rate >= 40 ? 'text-yellow-400' : 'text-red-400';
      const pnlClass = a.pnl_pct >= 0 ? 'text-green-400' : 'text-red-400';
      const pnlSign = a.pnl_pct >= 0 ? '+' : '';
      const isCopying = copyStatus?.copying && copyStatus.agent_name === a.name;
      const copyBtn = isCopying
        ? `<button onclick="stopCopying()" class="w-full mt-3 py-1.5 bg-red-600/20 border border-red-500/30 text-red-400 text-[10px] font-bold rounded hover:bg-red-600/30 transition-all">Stop Copying (${copyStatus.rounds_remaining} rounds left)</button>`
        : `<button onclick="openCopyModal('${a.uid}', '${a.name}')" class="w-full mt-3 py-1.5 bg-blue-600/20 border border-blue-500/30 text-blue-400 text-[10px] font-bold rounded hover:bg-blue-600/30 transition-all">Copy Agent</button>`;

      return `<div class="bg-white/[0.02] border border-white/5 rounded-lg p-3">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs font-bold text-white">${a.name}</div>
          <div class="text-[9px] text-slate-500">${a.total_bets} bets</div>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div>
            <div class="text-sm font-black ${wrClass}">${a.win_rate}%</div>
            <div class="text-[8px] text-slate-600">win rate</div>
          </div>
          <div>
            <div class="text-sm font-black ${pnlClass}">${pnlSign}${a.pnl_pct}%</div>
            <div class="text-[8px] text-slate-600">P&L</div>
          </div>
          <div>
            <div class="text-sm font-black text-white">${a.wins}/${a.losses}</div>
            <div class="text-[8px] text-slate-600">W/L</div>
          </div>
        </div>
        ${currentUser ? copyBtn : '<div class="mt-3 text-[9px] text-slate-600 text-center">Sign in to copy</div>'}
      </div>`;
    }).join('');

    // Update copy status badge
    const badge = document.getElementById('copy-status-badge');
    if (copyStatus?.copying) {
      badge.style.display = '';
      badge.textContent = `Copying ${copyStatus.agent_name} · ${copyStatus.rounds_remaining} rounds left`;
      badge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-blue-600/20 text-blue-400';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
}

function openCopyModal(agentUid, agentName) {
  if (!currentUser) return showToast('Sign in first', 'error');
  copyModalAgentUid = agentUid;
  document.getElementById('copy-modal-agent-name').textContent = agentName;
  document.getElementById('copy-modal').classList.remove('hidden');
}

document.getElementById('copy-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('copy-modal').classList.add('hidden');
  copyModalAgentUid = null;
});

document.getElementById('copy-modal-confirm')?.addEventListener('click', async () => {
  if (!copyModalAgentUid) return;
  const amount = parseFloat(document.getElementById('copy-modal-amount').value);
  const rounds = parseInt(document.getElementById('copy-modal-rounds').value);
  if (!amount || !rounds) return showToast('Enter amount and rounds', 'error');
  try {
    const res = await apiFetch('/copy-agent', 'POST', {
      agent_uid: copyModalAgentUid,
      amount,
      rounds,
    });
    showToast(`Copying ${res.copying} for ${res.rounds_remaining} rounds!`, 'success');
    document.getElementById('copy-modal').classList.add('hidden');
    copyModalAgentUid = null;
    loadPublicAgents(); // refresh
  } catch (e) {
    showToast('Failed to start copying: ' + (e.message || e), 'error');
  }
});

async function stopCopying() {
  try {
    await apiFetch('/stop-copy', 'POST');
    showToast('Stopped copying', 'success');
    loadPublicAgents();
  } catch (e) {
    showToast('Failed to stop: ' + (e.message || e), 'error');
  }
}

// Load agents after auth settles
setTimeout(loadPublicAgents, 2000);
setInterval(loadPublicAgents, 30000);

initApp();

// ── Wire up event listeners replacing inline onclick handlers (SEC-04) ──
document.querySelector('[data-action="toggle-music"]').addEventListener('click', toggleMusic);
document.querySelector('[data-action="gs-step-1"]')?.addEventListener('click', function() { handleGetStartedStep(1); });
document.querySelector('[data-action="gs-step-2"]')?.addEventListener('click', function() { handleGetStartedStep(2); });
document.querySelector('[data-action="select-up"]').addEventListener('click', function() { selectDirection('UP'); });
document.querySelector('[data-action="select-down"]').addEventListener('click', function() { selectDirection('DOWN'); });
document.querySelector('[data-action="close-bet-panel"]').addEventListener('click', closeBetPanel);
