import { db } from './supabase.js';

// ── STATE ─────────────────────────────────────────────────────────────
const state = {
  stores: [],
  issues: [],
  issueCounts: {},   // { storeId: { open, total } }
  activeScreen: 'stores',
  storeFilter: 'all',
  issueFilter: 'all',
  storeSearch: '',
  issueSearch: '',
  issueAccountFilter: '',
  issueCatFilter: '',
  selectedStore: null,
  loading: false
};

const ACCOUNT_CODES = {
  'Giant Food': 'GF', 'Wegmans': 'WM', 'Solidcore': 'SC',
  'Food Lion': 'FL', 'Office Depot': 'OD', 'Zara': 'ZA'
};
const ACCOUNT_CLASS = {
  'Giant Food': 'gf', 'Wegmans': 'wm', 'Solidcore': 'sc',
  'Food Lion': 'fl', 'Office Depot': 'od', 'Zara': 'za'
};

// ── INIT ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  await loadAll();
  renderHeader();
  switchScreen('stores');
  bindEvents();
});

async function loadAll() {
  setLoading(true);
  try {
    const activeOnly = document.getElementById('activeOnlyToggle')?.checked ?? false;
  const [stores, counts] = await Promise.all([db.getStores(activeOnly), db.getIssueCounts()]);
    state.stores = stores;
    // Build count map
    state.issueCounts = {};
    counts.forEach(i => {
      if (!state.issueCounts[i.store_id]) state.issueCounts[i.store_id] = { open: 0, total: 0 };
      state.issueCounts[i.store_id].total++;
      if (i.status !== 'resolved') state.issueCounts[i.store_id].open++;
    });
    await loadIssues();
  } catch (e) {
    showToast('Connection error — check network', 'error');
  }
  setLoading(false);
}

async function loadIssues(filters = {}) {
  try {
    state.issues = await db.getIssues(filters);
  } catch (e) {
    showToast('Failed to load issues', 'error');
  }
}

// ── EVENTS ────────────────────────────────────────────────────────────
function bindEvents() {
  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => switchScreen(el.dataset.screen));
  });

  // Store search
  document.getElementById('storeSearch').addEventListener('input', e => {
    state.storeSearch = e.target.value.toLowerCase();
    renderStores();
  });

  // Account filter chips
  document.querySelectorAll('#storeChips .chip').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#storeChips .chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      state.storeFilter = el.dataset.val;
      renderStores();
    });
  });

  // Issue filter chips
  document.querySelectorAll('#issueChips .chip').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#issueChips .chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      state.issueFilter = el.dataset.val;
      renderIssues();
    });
  });

  // Issue search
  document.getElementById('issueSearch').addEventListener('input', e => {
    state.issueSearch = e.target.value.toLowerCase();
    renderIssues();
  });

  // Issue account filter
  document.getElementById('issueAcctFilter').addEventListener('change', e => {
    state.issueAccountFilter = e.target.value;
    renderIssues();
  });

  // Issue category filter
  document.getElementById('issueCatFilter').addEventListener('change', e => {
    state.issueCatFilter = e.target.value;
    renderIssues();
  });

  // Log issue form
  document.getElementById('logForm').addEventListener('submit', handleLogIssue);

  // Add store modal
  document.getElementById('addStoreBtn').addEventListener('click', () => openModal('addStoreModal'));
  document.getElementById('cancelStore').addEventListener('click', () => closeModal('addStoreModal'));
  document.getElementById('saveStoreBtn').addEventListener('click', handleAddStore);

  // Detail screen back
  document.getElementById('backBtn').addEventListener('click', () => {
    state.selectedStore = null;
    switchScreen('stores');
  });

  // Detail log issue button
  document.getElementById('detailLogBtn').addEventListener('click', () => {
    const store = state.selectedStore;
    if (store) {
      const sel = document.getElementById('logStoreId');
      sel.value = store.id;
      switchScreen('log');
    }
  });

  // Populate log store today date
  document.getElementById('logDate').valueAsDate = new Date();

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); });
  });
}

// ── SCREENS ───────────────────────────────────────────────────────────
function switchScreen(name) {
  state.activeScreen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.screen === name));

  if (name === 'stores') { document.getElementById('scStores').classList.add('active'); renderStores(); }
  else if (name === 'issues') { document.getElementById('scIssues').classList.add('active'); renderIssues(); }
  else if (name === 'log') { document.getElementById('scLog').classList.add('active'); populateLogStores(); }
  else if (name === 'detail') { document.getElementById('scDetail').classList.add('active'); renderDetail(); }
  else if (name === 'reports') {
    document.getElementById('scReports').classList.add('active');
    if (!state.issues.length) loadIssues().then(renderReports);
    else renderReports();
  }
}

// ── RENDER STORES ─────────────────────────────────────────────────────
function renderStores() {
  const list = document.getElementById('storeList');
  let filtered = state.stores.filter(s => {
    if (state.storeFilter !== 'all' && s.account !== state.storeFilter) return false;
    if (state.storeSearch && !s.name.toLowerCase().includes(state.storeSearch) && !s.id.toLowerCase().includes(state.storeSearch)) return false;
    return true;
  });

  if (state.loading) { list.innerHTML = loadingHTML(); return; }
  if (!filtered.length) { list.innerHTML = emptyHTML('No stores found', 'Try adjusting your search or filter'); return; }

  list.innerHTML = filtered.map(s => {
    const counts = state.issueCounts[s.id] || { open: 0, total: 0 };
    const cls = ACCOUNT_CLASS[s.account] || 'gf';
    const code = ACCOUNT_CODES[s.account] || '??';
    const pillHtml = counts.open > 0
      ? `<span class="issue-pill pill-open">${counts.open} open</span>`
      : `<span class="issue-pill pill-ok">✓ clear</span>`;
    const inactive = s.active === false;
    return `<div class="store-card ${counts.open > 0 ? 'has-issues' : ''} ${inactive ? 'inactive' : ''}" onclick="openStoreDetail('${s.id}')">
      <div class="store-avatar av-${cls}">${code}</div>
      <div class="store-info">
        <div class="store-name">${s.name}</div>
        <div class="store-meta">${s.id} · ${s.state}${inactive ? ' · <span style="color:var(--danger)">inactive</span>' : ''}</div>
      </div>
      <div class="store-right">
        ${pillHtml}
        <span class="chevron">›</span>
      </div>
    </div>`;
  }).join('');
}

// ── RENDER ISSUES ─────────────────────────────────────────────────────
function renderIssues() {
  const list = document.getElementById('issueList');
  let filtered = state.issues.filter(i => {
    if (state.issueFilter !== 'all') {
      const status = i.status.replace(' ', '-');
      if (state.issueFilter === 'in-progress' && i.status !== 'in progress') return false;
      if (state.issueFilter !== 'in-progress' && state.issueFilter !== 'all' && i.status !== state.issueFilter) return false;
    }
    if (state.issueAccountFilter && i.stores?.account !== state.issueAccountFilter) return false;
    if (state.issueCatFilter && i.category !== state.issueCatFilter) return false;
    if (state.issueSearch) {
      const q = state.issueSearch;
      if (!i.description?.toLowerCase().includes(q) && !i.store_id?.toLowerCase().includes(q) && !i.stores?.name?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  document.getElementById('issueCount').textContent = `${filtered.length} issue${filtered.length !== 1 ? 's' : ''}`;

  if (state.loading) { list.innerHTML = loadingHTML(); return; }
  if (!filtered.length) { list.innerHTML = emptyHTML('No issues found', 'Log a new issue from the + tab'); return; }

  list.innerHTML = filtered.map(i => issueCardHTML(i)).join('');
}

function issueCardHTML(i) {
  const storeName = i.stores?.name || i.store_id;
  const acct = i.stores?.account || '';
  const cls = ACCOUNT_CLASS[acct] || '';
  const statusClass = i.status === 'in progress' ? 'inprogress' : i.status;
  const cardClass = i.status === 'in progress' ? 'in-progress' : i.status;
  const sbClass = i.status === 'in progress' ? 'sb-inprogress' : `sb-${i.status}`;
  const resolveBtn = i.status !== 'resolved'
    ? `<button class="action-btn resolve" onclick="resolveIssue(${i.id})">✓ Resolve</button>` : '';
  return `<div class="issue-card ${cardClass}" id="issue-${i.id}">
    <div class="issue-top">
      <div class="issue-store-name">${storeName}</div>
      <div class="issue-date">${i.date}</div>
    </div>
    <div class="issue-tags">
      ${acct ? `<span class="tag tag-acct tag-${cls}">${acct}</span>` : ''}
      <span class="tag">${i.category}</span>
      ${i.assignee ? `<span class="tag">→ ${i.assignee}</span>` : ''}
    </div>
    <div class="issue-desc">${i.description}</div>
    <div class="issue-footer">
      <span class="status-badge ${sbClass}">${i.status.toUpperCase()}</span>
      <div class="issue-actions">
        ${resolveBtn}
        <button class="action-btn del" onclick="deleteIssue(${i.id})">✕</button>
      </div>
    </div>
  </div>`;
}

// ── DETAIL SCREEN ─────────────────────────────────────────────────────
window.openStoreDetail = async function(storeId) {
  const store = state.stores.find(s => s.id === storeId);
  if (!store) return;
  state.selectedStore = store;
  setLoading(true);
  state.issues = await db.getIssues({ storeId });
  setLoading(false);
  switchScreen('detail');
};

function renderDetail() {
  const s = state.selectedStore;
  if (!s) return;

  document.getElementById('detailTitle').textContent = s.name;
  document.getElementById('detailSub').textContent = `${s.id} · ${s.account} · ${s.state}`;

  const activeBtn = document.getElementById('detailActiveBtn');
  activeBtn.textContent = s.active === false ? '⚑ Set Active' : '⊘ Set Inactive';
  activeBtn.className = `action-btn ${s.active === false ? 'resolve' : 'del'}`;
  activeBtn.onclick = () => toggleStoreActive(s.id, s.active);

  const counts = state.issueCounts[s.id] || { open: 0, total: 0 };
  const resolved = state.issues.filter(i => i.status === 'resolved').length;
  document.getElementById('detailOpen').innerHTML = `<div class="dstat-val ${counts.open > 0 ? 'warn' : 'ok'}">${counts.open}</div><div class="dstat-label">Open</div>`;
  document.getElementById('detailResolved').innerHTML = `<div class="dstat-val ok">${resolved}</div><div class="dstat-label">Resolved</div>`;
  document.getElementById('detailTotal').innerHTML = `<div class="dstat-val">${state.issues.length}</div><div class="dstat-label">Total</div>`;

  const list = document.getElementById('detailIssueList');
  if (!state.issues.length) { list.innerHTML = emptyHTML('No issues logged', 'Tap "Log issue" to add one'); return; }
  list.innerHTML = state.issues.map(i => issueCardHTML(i)).join('');
}

// ── LOG ISSUE ─────────────────────────────────────────────────────────
function populateLogStores() {
  const sel = document.getElementById('logStoreId');
  const sorted = [...state.stores].sort((a, b) => a.account.localeCompare(b.account) || a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">Select store…</option>' +
    sorted.map(s => `<option value="${s.id}">${s.id} — ${s.name}</option>`).join('');
}

async function handleLogIssue(e) {
  e.preventDefault();
  const storeId = document.getElementById('logStoreId').value;
  const desc = document.getElementById('logDesc').value.trim();
  if (!storeId || !desc) { showToast('Store and description required', 'error'); return; }

  const btn = document.getElementById('logSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await db.addIssue({
      store_id: storeId,
      category: document.getElementById('logCategory').value,
      date: document.getElementById('logDate').value || new Date().toISOString().split('T')[0],
      description: desc,
      status: document.getElementById('logStatus').value,
      assignee: document.getElementById('logAssignee').value.trim() || null
    });
    showToast('Issue logged ✓', 'success');
    document.getElementById('logForm').reset();
    document.getElementById('logDate').valueAsDate = new Date();
    await loadAll();
    renderHeader();
  } catch (err) {
    showToast('Failed to save — try again', 'error');
  }
  btn.disabled = false; btn.textContent = 'Log Issue';
}

// ── RESOLVE / DELETE ──────────────────────────────────────────────────
window.resolveIssue = async function(id) {
  try {
    await db.updateIssue(id, { status: 'resolved', updated_at: new Date().toISOString() });
    showToast('Marked resolved ✓', 'success');
    await loadAll();
    if (state.activeScreen === 'detail') renderDetail();
    else renderIssues();
    renderHeader();
  } catch { showToast('Failed to update', 'error'); }
};

window.deleteIssue = async function(id) {
  if (!confirm('Delete this issue?')) return;
  try {
    await db.deleteIssue(id);
    showToast('Issue deleted', 'success');
    state.issues = state.issues.filter(i => i.id !== id);
    await loadAll();
    if (state.activeScreen === 'detail') renderDetail();
    else renderIssues();
    renderHeader();
  } catch { showToast('Failed to delete', 'error'); }
};

window.toggleStoreActive = async function(id, currentActive) {
  const newActive = currentActive === false ? true : false;
  try {
    await db.toggleActive(id, newActive);
    const store = state.stores.find(s => s.id === id);
    if (store) store.active = newActive;
    if (state.selectedStore?.id === id) state.selectedStore.active = newActive;
    showToast(newActive ? 'Store set active ✓' : 'Store set inactive', newActive ? 'success' : 'error');
    renderDetail();
    renderStores();
  } catch { showToast('Failed to update', 'error'); }
};


async function handleAddStore() {
  const id = document.getElementById('newStoreId').value.trim().toUpperCase();
  const name = document.getElementById('newStoreName').value.trim();
  if (!id || !name) { showToast('ID and name required', 'error'); return; }
  try {
    await db.addStore({
      id, name,
      account: document.getElementById('newStoreAccount').value,
      state: document.getElementById('newStoreState').value,
      address: document.getElementById('newStoreAddress').value.trim() || null
    });
    showToast('Store added ✓', 'success');
    closeModal('addStoreModal');
    ['newStoreId','newStoreName','newStoreAddress'].forEach(f => document.getElementById(f).value = '');
    await loadAll();
    renderStores();
    renderHeader();
  } catch (e) {
    showToast(e.message.includes('duplicate') ? 'Store ID already exists' : 'Failed to add store', 'error');
  }
}

// ── HEADER ────────────────────────────────────────────────────────────
function renderHeader() {
  const totalOpen = Object.values(state.issueCounts).reduce((sum, c) => sum + c.open, 0);
  document.getElementById('headerStats').innerHTML = `
    <div class="hstat"><b>${state.stores.length}</b> stores</div>
    <div class="hstat ${totalOpen > 0 ? 'warn' : ''}"><b>${totalOpen}</b> open</div>
  `;
}

// ── HELPERS ───────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
window.openModal = openModal; window.closeModal = closeModal;

function setLoading(val) { state.loading = val; }

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 2500);
}

function loadingHTML() {
  return `<div class="loading"><div class="spinner"></div>Loading…</div>`;
}

function emptyHTML(text, sub = '') {
  return `<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">${text}</div>${sub ? `<div class="empty-sub">${sub}</div>` : ''}</div>`;
}

// ── REPORTS ───────────────────────────────────────────────────────────
let reportPeriod = 'week';
let trendChartInstance = null;

window.setReportPeriod = function(period, el) {
  reportPeriod = period;
  document.querySelectorAll('#scReports .chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderReports();
};

function getReportIssues() {
  const now = new Date();
  let cutoff = null;
  if (reportPeriod === 'week') {
    cutoff = new Date(now); cutoff.setDate(now.getDate() - 7);
  } else if (reportPeriod === 'month') {
    cutoff = new Date(now); cutoff.setMonth(now.getMonth() - 1);
  }
  if (!cutoff) return state.issues;
  const cutoffStr = cutoff.toISOString().split('T')[0];
  return state.issues.filter(i => i.date >= cutoffStr);
}

function renderReports() {
  const issues = getReportIssues();
  const label = reportPeriod === 'week' ? 'Last 7 days' : reportPeriod === 'month' ? 'Last 30 days' : 'All time';
  document.getElementById('reportsSub').textContent = `${label} · ${issues.length} issues`;

  // KPIs
  const open = issues.filter(i => i.status === 'open').length;
  const inprog = issues.filter(i => i.status === 'in progress').length;
  const resolved = issues.filter(i => i.status === 'resolved').length;
  document.getElementById('reportKpis').innerHTML = `
    <div class="report-kpi"><div class="report-kpi-val" style="color:var(--warn)">${open}</div><div class="report-kpi-label">Open</div></div>
    <div class="report-kpi"><div class="report-kpi-val" style="color:#facc15">${inprog}</div><div class="report-kpi-label">In Progress</div></div>
    <div class="report-kpi"><div class="report-kpi-val" style="color:var(--accent)">${resolved}</div><div class="report-kpi-label">Resolved</div></div>
  `;

  // By account
  const acctMap = {};
  issues.forEach(i => {
    const acct = i.stores?.account || 'Unknown';
    if (!acctMap[acct]) acctMap[acct] = { open: 0, total: 0 };
    acctMap[acct].total++;
    if (i.status !== 'resolved') acctMap[acct].open++;
  });
  const acctColors = { 'Giant Food':'#00e5a0','Wegmans':'#0099ff','Solidcore':'#c084fc','Food Lion':'#fb923c','Office Depot':'#60a5fa','Zara':'#f472b6' };
  const maxAcct = Math.max(...Object.values(acctMap).map(v => v.total), 1);
  document.getElementById('reportByAccount').innerHTML = Object.entries(acctMap)
    .sort((a,b) => b[1].total - a[1].total)
    .map(([acct, v]) => `
      <div class="report-bar-row">
        <div class="report-bar-label">${acct}</div>
        <div class="report-bar-wrap"><div class="report-bar-fill" style="width:${Math.round(v.total/maxAcct*100)}%;background:${acctColors[acct]||'var(--accent)'}"></div></div>
        <div class="report-bar-count">${v.total}</div>
      </div>`).join('') || '<div class="empty-text" style="padding:12px 0">No data</div>';

  // By category
  const catMap = {};
  issues.forEach(i => {
    catMap[i.category] = (catMap[i.category] || 0) + 1;
  });
  const maxCat = Math.max(...Object.values(catMap), 1);
  document.getElementById('reportByCategory').innerHTML = Object.entries(catMap)
    .sort((a,b) => b[1] - a[1])
    .map(([cat, count]) => `
      <div class="report-bar-row">
        <div class="report-bar-label">${cat}</div>
        <div class="report-bar-wrap"><div class="report-bar-fill" style="width:${Math.round(count/maxCat*100)}%;background:var(--blue)"></div></div>
        <div class="report-bar-count">${count}</div>
      </div>`).join('') || '<div class="empty-text" style="padding:12px 0">No data</div>';

  // Top stores
  const storeMap = {};
  issues.forEach(i => {
    if (!storeMap[i.store_id]) storeMap[i.store_id] = { open: 0, total: 0, name: i.stores?.name || i.store_id, acct: i.stores?.account || '' };
    storeMap[i.store_id].total++;
    if (i.status !== 'resolved') storeMap[i.store_id].open++;
  });
  const topStores = Object.entries(storeMap).sort((a,b) => b[1].open - a[1].open).slice(0, 8);
  document.getElementById('reportTopStores').innerHTML = topStores.length
    ? topStores.map(([id, v]) => `
      <div class="report-store-row" onclick="openStoreDetail('${id}')">
        <div>
          <div class="report-store-name">${v.name}</div>
          <div class="report-store-meta">${v.acct} · ${v.total} total</div>
        </div>
        <span class="issue-pill ${v.open > 0 ? 'pill-open' : 'pill-ok'}">${v.open > 0 ? v.open + ' open' : '✓ clear'}</span>
      </div>`).join('')
    : '<div class="empty-text" style="padding:12px 0;color:var(--muted);font-size:13px">No issues in this period</div>';

  // Trend chart
  renderTrendChart(issues);
}

function renderTrendChart(issues) {
  const canvas = document.getElementById('trendChart');
  if (!canvas) return;

  // Build daily buckets for last 14 days
  const days = 14;
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    buckets[key] = { logged: 0, resolved: 0 };
  }
  issues.forEach(i => {
    if (buckets[i.date]) buckets[i.date].logged++;
    if (i.status === 'resolved' && buckets[i.date]) buckets[i.date].resolved++;
  });

  const labels = Object.keys(buckets).map(d => d.slice(5)); // MM-DD
  const logged = Object.values(buckets).map(b => b.logged);
  const resolved = Object.values(buckets).map(b => b.resolved);

  if (trendChartInstance) { trendChartInstance.destroy(); trendChartInstance = null; }

  if (typeof Chart === 'undefined') return;

  trendChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Logged', data: logged, backgroundColor: '#ff6b3588', borderRadius: 3 },
        { label: 'Resolved', data: resolved, backgroundColor: '#00e5a066', borderRadius: 3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#6b7785', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#6b7785', font: { size: 10 } }, grid: { color: '#2a3038' } },
        y: { ticks: { color: '#6b7785', font: { size: 10 }, stepSize: 1 }, grid: { color: '#2a3038' }, beginAtZero: true }
      }
    }
  });
}
