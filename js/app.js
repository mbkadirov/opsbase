import { db, auth } from './supabase.js';
import { healthScore, issuePoints, daysSince, isOpen, band } from './health.js';

// ── STATE ─────────────────────────────────────────────────────────────
const state = {
  stores: [],
  issues: [],
  byId: new Map(),
  screen: 'stores',
  storeAccount: 'all',
  storeSearch: '',
  showInactive: false,
  issueStatus: 'active',
  issueSearch: '',
  issueAccount: '',
  issueCategory: '',
  reportPeriod: 'week',
  selectedId: null,
  loaded: false,
  pendingDelete: null,
  me: null,
  starting: false,
  profiles: [],
  assignments: [],
  authMode: 'signin',
  assignUser: null
};

const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', crew_lead: 'Crew lead', pending: 'Pending', disabled: 'Disabled' };
const STAFF = ['admin', 'supervisor', 'crew_lead'];
const isAdmin = () => state.me?.role === 'admin';
const canDelete = () => ['admin', 'supervisor'].includes(state.me?.role);
const canSeeUsers = () => ['admin', 'supervisor'].includes(state.me?.role);

const ACCOUNT_ORDER = ['Wegmans', 'Zara', 'Office Depot', 'Food Lion', 'Giant Food', 'Solidcore'];
const ACCOUNT_CODES = { 'Giant Food': 'GF', 'Wegmans': 'WM', 'Solidcore': 'SC', 'Food Lion': 'FL', 'Office Depot': 'OD', 'Zara': 'ZA' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const acctRank = (a) => { const i = ACCOUNT_ORDER.indexOf(a); return i < 0 ? 99 : i; };
const storeNum = (s) => parseInt(String(s.name).replace(/^\D+/, ''), 10) || 0;
const city = (s) => s?.address || s?.state || '';
const today = () => new Date().toISOString().split('T')[0];

// ── INIT ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  bindEvents();
  bindAuthEvents();
  $('logDate').value = today();
  auth.onChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { $('newPassword').value = ''; openSheet('passwordSheet'); }
    if (event === 'SIGNED_OUT') showSignedOut();
    if (event === 'SIGNED_IN' && session && !state.me && !state.starting) setTimeout(() => start(session), 0);
  });
  try {
    const session = await auth.session();
    if (session) await start(session); else showSignedOut();
  } catch { showSignedOut(); }
});

// ── SIGN-IN FLOW ─────────────────────────────────────────────────────
async function start(session) {
  if (state.starting) return;
  state.starting = true;
  try {
    let me = null;
    try { me = await db.myProfile(session.user.id); } catch { /* table missing or offline */ }
    state.me = me || { id: session.user.id, email: session.user.email, full_name: '', role: 'pending' };
    if (!STAFF.includes(state.me.role)) { showPending(); return; }
    document.body.classList.remove('signed-out');
    renderAvatar();
    $('addStoreBtn').hidden = !isAdmin();
    await loadAll();
    switchScreen('stores');
  } finally {
    state.starting = false;
  }
}

function showSignedOut() {
  state.me = null; state.stores = []; state.issues = []; state.byId = new Map(); state.loaded = false;
  document.body.classList.add('signed-out');
  setAuthMode('signin');
  switchScreen('auth');
}

function showPending() {
  document.body.classList.add('signed-out');
  const disabled = state.me?.role === 'disabled';
  $('pendingTitle').textContent = disabled ? 'Access removed' : 'Waiting for access';
  $('pendingText').textContent = disabled
    ? 'Your OpsBase access has been turned off. Contact Murod if you think this is a mistake.'
    : `You're signed in as ${state.me?.email || 'a new user'}. An admin needs to give you a role before you can see stores. Ask Murod to approve you, then tap Check again.`;
  switchScreen('pending');
}

function setAuthMode(mode) {
  state.authMode = mode;
  $('authTabs').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.val === mode));
  const up = mode === 'signup';
  $('authTitle').textContent = up ? 'Create account' : 'Sign in';
  $('authSub').textContent = up ? 'An admin approves new accounts before they can see stores.' : 'Store health and issues for CSG field teams.';
  $('authNameField').hidden = !up;
  $('authPassword').autocomplete = up ? 'new-password' : 'current-password';
  $('authPassword').placeholder = up ? 'At least 8 characters' : '';
  $('authSubmit').textContent = up ? 'Create account' : 'Sign in';
  $('authLinks').hidden = up;
  authMsg();
}

function authMsg(error = '', note = '') {
  $('authError').textContent = error; $('authError').hidden = !error;
  $('authNote').textContent = note; $('authNote').hidden = !note;
}

function friendlyAuthError(e) {
  const m = String(e?.message || e || '');
  if (/invalid login/i.test(m)) return 'Wrong email or password.';
  if (/not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the link we sent.';
  if (/signups not allowed|user not found/i.test(m)) return 'No account with that email yet. Use Create account.';
  if (/already registered/i.test(m)) return 'That email already has an account. Sign in instead.';
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute and try again.';
  if (/password/i.test(m)) return 'Use a password with at least 8 characters.';
  return "Couldn't reach OpsBase. Check your connection and try again.";
}

function bindAuthEvents() {
  chipGroup('authTabs', (v) => setAuthMode(v));
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim();
    const pw = $('authPassword').value;
    const name = $('authName').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Enter your email address.');
    if (state.authMode === 'signup' && !name) return authMsg('Enter your name.');
    if (pw.length < 8) return authMsg(state.authMode === 'signup' ? 'Use a password with at least 8 characters.' : 'Enter your password.');
    const btn = $('authSubmit'); btn.disabled = true; authMsg();
    try {
      if (state.authMode === 'signin') {
        const { session } = await auth.signIn(email, pw);
        await start(session);
      } else {
        const res = await auth.signUp(email, pw, name);
        if (res.session) await start(res.session);
        else { setAuthMode('signin'); authMsg('', `Check ${email} for a confirmation link. After you confirm, sign in here and an admin will approve you.`); }
      }
    } catch (err) { authMsg(friendlyAuthError(err)); }
    btn.disabled = false;
  });
  $('authLinkBtn').addEventListener('click', async () => {
    const email = $('authEmail').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Enter your email address first.');
    try { await auth.sendLink(email); authMsg('', `Sign-in link sent to ${email}. Open it on this device.`); }
    catch (err) { authMsg(friendlyAuthError(err)); }
  });
  $('authResetBtn').addEventListener('click', async () => {
    const email = $('authEmail').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Enter your email address first.');
    try { await auth.sendReset(email); authMsg('', `Password reset link sent to ${email}. Open it, then choose a new password.`); }
    catch (err) { authMsg(friendlyAuthError(err)); }
  });
  $('pendingRefresh').addEventListener('click', async () => {
    const session = await auth.session().catch(() => null);
    if (!session) return showSignedOut();
    state.me = null;
    await start(session);
    if (state.me && !STAFF.includes(state.me.role)) showToast('Still waiting for an admin to approve you.');
  });
  $('pendingSignOut').addEventListener('click', () => auth.signOut().catch(() => showSignedOut()));

  $('accountBtn').addEventListener('click', openAccount);
  $('saveAccountBtn').addEventListener('click', saveAccount);
  $('signOutBtn').addEventListener('click', async () => { closeSheet('accountSheet'); await auth.signOut().catch(() => {}); showSignedOut(); });
  $('manageUsersBtn').addEventListener('click', () => { closeSheet('accountSheet'); switchScreen('users'); });
  $('usersBackBtn').addEventListener('click', () => switchScreen('stores'));
  $('assignCancel').addEventListener('click', () => closeSheet('assignSheet'));
  $('assignSave').addEventListener('click', saveAssignments);
  $('pwSave').addEventListener('click', async () => {
    const pw = $('newPassword').value;
    if (pw.length < 8) { $('pwError').textContent = 'Use at least 8 characters.'; $('pwError').hidden = false; return; }
    try { await auth.setPassword(pw); closeSheet('passwordSheet'); showToast('Password saved'); }
    catch (err) { $('pwError').textContent = friendlyAuthError(err); $('pwError').hidden = false; }
  });
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-role-for]');
    if (sel) changeRole(sel.dataset.roleFor, sel.value, sel);
  });
}

// ── ACCOUNT ───────────────────────────────────────────────────────────
const initials = (p) => {
  const src = (p?.full_name || p?.email || '?').trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (p?.full_name && parts[1] ? parts[1][0] : '')).toUpperCase();
};

function renderAvatar() {
  const b = $('accountBtn');
  b.hidden = !state.me;
  b.textContent = initials(state.me);
}

function openAccount() {
  $('accountWho').textContent = `${state.me.email} · ${ROLE_LABEL[state.me.role] || state.me.role}`;
  $('accountName').value = state.me.full_name || '';
  $('accountPassword').value = '';
  $('accountError').hidden = true;
  $('manageUsersBtn').hidden = !canSeeUsers();
  openSheet('accountSheet');
}

async function saveAccount() {
  const name = $('accountName').value.trim();
  const pw = $('accountPassword').value;
  const err = $('accountError');
  if (pw && pw.length < 8) { err.textContent = 'Use a password with at least 8 characters.'; err.hidden = false; return; }
  try {
    if (name !== (state.me.full_name || '')) { await db.setMyName(name); state.me.full_name = name; renderAvatar(); }
    if (pw) await auth.setPassword(pw);
    closeSheet('accountSheet');
    showToast(pw ? 'Account and password saved' : 'Account saved');
  } catch (e) { err.textContent = friendlyAuthError(e); err.hidden = false; }
}

// ── USERS (admin) ─────────────────────────────────────────────────────
async function renderUsers() {
  const list = $('userList');
  if (!canSeeUsers()) { switchScreen('stores'); return; }
  list.innerHTML = loadingHTML('Loading users…');
  try {
    [state.profiles, state.assignments] = await Promise.all([db.getProfiles(), db.getAssignments()]);
  } catch {
    list.innerHTML = emptyHTML("Couldn't load users", 'Check your connection and try again.');
    return;
  }
  const order = { pending: 0, admin: 1, supervisor: 2, crew_lead: 3, disabled: 4 };
  const people = [...state.profiles].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
  const waiting = people.filter((p) => p.role === 'pending').length;
  $('usersSub').textContent = `${people.length} user${people.length === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting for approval` : ''}`;
  list.innerHTML = people.map((p) => {
    const self = p.id === state.me.id;
    const stores = state.assignments.filter((a) => a.user_id === p.id).map((a) => state.byId.get(a.store_id)?.name || a.store_id);
    const roleCtl = isAdmin() && !self
      ? `<select data-role-for="${esc(p.id)}" aria-label="Role for ${esc(p.full_name || p.email)}">${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${p.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`
      : `<span class="tag role-${esc(p.role)}">${esc(ROLE_LABEL[p.role] || p.role)}${self ? ' · you' : ''}</span>`;
    return `<article class="user-card ${p.role === 'pending' ? 'pending' : ''}">
      <div class="user-top">
        <div class="avatar" aria-hidden="true">${esc(initials(p))}</div>
        <div class="user-id"><div class="user-name">${esc(p.full_name || p.email)}</div><div class="user-email">${esc(p.email || '')}</div></div>
      </div>
      <div class="user-row">${roleCtl}
        ${p.role === 'crew_lead' && isAdmin() ? `<button class="btn btn-sm" data-act="assign" data-id="${esc(p.id)}"><i class="ti ti-building-store" aria-hidden="true"></i>Stores</button>` : ''}
      </div>
      ${p.role === 'crew_lead' ? `<div class="user-stores">${stores.length ? `<b>${stores.length} store${stores.length === 1 ? '' : 's'}:</b> ${esc(stores.join(', '))}` : 'No stores assigned yet, so they see nothing.'}</div>` : ''}
    </article>`;
  }).join('') || emptyHTML('No users yet');
}

async function changeRole(id, role, sel) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  const prev = p.role;
  sel.disabled = true;
  try {
    await db.setRole(id, role);
    p.role = role;
    showToast(`${p.full_name || p.email} is now ${ROLE_LABEL[role]}`);
    await renderUsers();
    if (role === 'crew_lead' && !state.assignments.some((a) => a.user_id === id)) openAssign(id);
  } catch {
    sel.value = prev;
    showToast("Couldn't change the role. Try again.", { error: true });
  }
  sel.disabled = false;
}

function openAssign(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  state.assignUser = id;
  const mine = new Set(state.assignments.filter((a) => a.user_id === id).map((a) => a.store_id));
  $('assignTitle').textContent = `Stores for ${p.full_name || p.email}`;
  const stores = state.stores.filter((s) => isActiveStore(s) || mine.has(s.id))
    .sort((a, b) => acctRank(a.account) - acctRank(b.account) || storeNum(a) - storeNum(b));
  let last = '';
  $('assignList').innerHTML = stores.map((s) => {
    const head = s.account !== last ? `<div class="assign-group">${esc(s.account)}</div>` : '';
    last = s.account;
    return `${head}<label class="assign-item"><input type="checkbox" value="${esc(s.id)}" ${mine.has(s.id) ? 'checked' : ''}><span>${esc(s.name)} <small>${esc(city(s))}</small></span></label>`;
  }).join('');
  openSheet('assignSheet');
}

async function saveAssignments() {
  const ids = [...$('assignList').querySelectorAll('input:checked')].map((i) => i.value);
  const btn = $('assignSave'); btn.disabled = true;
  try {
    await db.setAssignments(state.assignUser, ids);
    closeSheet('assignSheet');
    showToast(`${ids.length} store${ids.length === 1 ? '' : 's'} assigned`);
    await renderUsers();
  } catch {
    showToast("Couldn't save the stores. Try again.", { error: true });
  }
  btn.disabled = false;
}

async function loadAll() {
  if (!state.me) return;
  try {
    const [stores, issues] = await Promise.all([db.getStores(), db.getIssues()]);
    state.stores = stores;
    state.issues = issues;
    state.byId = new Map(stores.map((s) => [s.id, s]));
    state.loaded = true;
  } catch (e) {
    showToast("Couldn't reach the database. Check your connection and pull to refresh.", { error: true });
  }
  renderHeader();
  renderAccountControls();
}

// Derived data
const isActiveStore = (s) => s && s.active !== false;
const issuesFor = (id) => state.issues.filter((i) => i.store_id === id);
const scoreFor = (id) => healthScore(issuesFor(id));
const openCountFor = (id) => issuesFor(id).filter(isOpen).length;
const visibleIssues = () => state.issues.filter((i) => state.showInactive || isActiveStore(state.byId.get(i.store_id)));

// ── EVENTS ────────────────────────────────────────────────────────────
function bindEvents() {
  document.querySelectorAll('.nav-item').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.screen === 'log') resetLogForm();
    switchScreen(el.dataset.screen);
  }));

  $('storeSearch').addEventListener('input', (e) => { state.storeSearch = e.target.value.trim().toLowerCase(); renderStores(); });
  $('showInactive').addEventListener('change', (e) => { state.showInactive = e.target.checked; renderAccountControls(); renderStores(); renderHeader(); });

  $('issueSearch').addEventListener('input', (e) => { state.issueSearch = e.target.value.trim().toLowerCase(); renderIssues(); });
  $('issueAcctFilter').addEventListener('change', (e) => { state.issueAccount = e.target.value; renderIssues(); });
  $('issueCatFilter').addEventListener('change', (e) => { state.issueCategory = e.target.value; renderIssues(); });
  chipGroup('issueChips', (v) => { state.issueStatus = v; renderIssues(); });
  chipGroup('reportChips', (v) => { state.reportPeriod = v; renderReports(); });

  $('logForm').addEventListener('submit', handleSaveIssue);
  $('logDesc').addEventListener('input', () => { $('logError').hidden = true; });
  $('logStoreId').addEventListener('change', () => { $('logError').hidden = true; });
  $('logCancelBtn').addEventListener('click', () => { const back = state.selectedId ? 'detail' : 'issues'; resetLogForm(); switchScreen(back); });

  $('addStoreBtn').addEventListener('click', () => openSheet('addStoreModal'));
  $('cancelStore').addEventListener('click', () => closeSheet('addStoreModal'));
  $('saveStoreBtn').addEventListener('click', handleAddStore);
  document.querySelectorAll('.sheet-overlay').forEach((el) => el.addEventListener('click', (e) => { if (e.target === el) closeSheet(el.id); }));

  $('isClose').addEventListener('click', () => closeSheet('issueSheet'));
  $('isCommentForm').addEventListener('submit', postComment);
  $('noteCancel').addEventListener('click', () => closeSheet('noteSheet'));
  $('noteSubmit').addEventListener('click', submitNote);
  $('noteText').addEventListener('input', () => { $('noteError').hidden = true; });
  $('backBtn').addEventListener('click', () => { state.selectedId = null; switchScreen('stores'); });
  $('detailLogBtn').addEventListener('click', () => { resetLogForm(); $('logStoreId').value = state.selectedId || ''; switchScreen('log'); });

  // Delegated clicks for rendered lists
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const { act, id } = t.dataset;
    if (act === 'store') openStore(id);
    else if (act === 'status') setStatus(Number(id), t.dataset.to);
    else if (act === 'issue') openIssue(Number(id));
    else if (act === 'resolve') openNote('resolve', Number(id));
    else if (act === 'approve') approveIssue(Number(id));
    else if (act === 'sendback') openNote('sendback', Number(id));
    else if (act === 'reopen') openNote('reopen', Number(id));
    else if (act === 'edit') editIssue(Number(id));
    else if (act === 'delete') deleteIssue(Number(id));
    else if (act === 'assign') openAssign(id);
  });
}

function chipGroup(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $(id).querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    onPick(chip.dataset.val);
  });
}

// ── SCREENS ───────────────────────────────────────────────────────────
const SCREENS = { stores: 'scStores', issues: 'scIssues', log: 'scLog', detail: 'scDetail', reports: 'scReports', auth: 'scAuth', pending: 'scPending', users: 'scUsers' };
function switchScreen(name) {
  state.screen = name;
  Object.entries(SCREENS).forEach(([k, id]) => $(id).classList.toggle('active', k === name));
  const navName = name === 'detail' || name === 'users' ? 'stores' : name;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.screen === navName));
  if (name === 'stores') renderStores();
  else if (name === 'issues') renderIssues();
  else if (name === 'log') populateLogStores();
  else if (name === 'detail') renderDetail();
  else if (name === 'reports') renderReports();
  else if (name === 'users') renderUsers();
  window.scrollTo({ top: 0 });
}

function rerender() {
  renderHeader();
  if (state.screen === 'stores') renderStores();
  else if (state.screen === 'issues') renderIssues();
  else if (state.screen === 'detail') renderDetail();
  else if (state.screen === 'reports') renderReports();
}

// ── HEADER & ACCOUNT CONTROLS ─────────────────────────────────────────
function renderHeader() {
  const active = state.stores.filter(isActiveStore);
  const open = state.issues.filter((i) => isOpen(i) && isActiveStore(state.byId.get(i.store_id))).length;
  $('headerStats').innerHTML = `<span><b>${active.length}</b> stores</span><span class="${open ? 'warn' : ''}"><b>${open}</b> open</span>`;
  const badge = $('navBadge');
  badge.hidden = !open;
  badge.textContent = open > 99 ? '99+' : String(open);
}

function shownStores() {
  return state.stores.filter((s) => state.showInactive || isActiveStore(s));
}

function renderAccountControls() {
  const stores = shownStores();
  const accounts = [...new Set(stores.map((s) => s.account))].sort((a, b) => acctRank(a) - acctRank(b));
  if (state.storeAccount !== 'all' && !accounts.includes(state.storeAccount)) state.storeAccount = 'all';
  const chip = (val, label, n) => `<button class="chip ${state.storeAccount === val ? 'active' : ''}" data-val="${esc(val)}">${esc(label)}<span class="n">${n}</span></button>`;
  $('storeChips').innerHTML = chip('all', 'All', stores.length) + accounts.map((a) => chip(a, a, stores.filter((s) => s.account === a).length)).join('');
  if (!$('storeChips').dataset.bound) {
    chipGroup('storeChips', (v) => { state.storeAccount = v; renderStores(); });
    $('storeChips').dataset.bound = '1';
  }
  const sel = $('issueAcctFilter');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All accounts</option>' + accounts.map((a) => `<option>${esc(a)}</option>`).join('');
  sel.value = accounts.includes(keep) ? keep : '';
  state.issueAccount = sel.value;

  const nAcct = accounts.length;
  $('storesSub').textContent = state.loaded ? `${stores.length} location${stores.length === 1 ? '' : 's'} · ${nAcct} account${nAcct === 1 ? '' : 's'}` : 'Loading…';
}

// ── STORES ────────────────────────────────────────────────────────────
function scoreBadge(score, cls = '') {
  return `<div class="score ${band(score)} ${cls}" style="--v:${score}" title="Health score ${score}"><span>${score}</span></div>`;
}

function renderStores() {
  const list = $('storeList');
  if (!state.loaded) { list.innerHTML = loadingHTML('Loading stores…'); return; }
  const q = state.storeSearch;
  const stores = shownStores().filter((s) => {
    if (state.storeAccount !== 'all' && s.account !== state.storeAccount) return false;
    if (q && ![s.name, s.id, s.address, s.state].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  });
  if (!stores.length) {
    list.innerHTML = !state.stores.length && state.me?.role === 'crew_lead'
      ? emptyHTML('No stores assigned yet', 'Ask an admin to assign your stores.')
      : emptyHTML('No stores match', 'Try another search or account.');
    return;
  }

  const groups = new Map();
  stores.forEach((s) => { if (!groups.has(s.account)) groups.set(s.account, []); groups.get(s.account).push(s); });
  list.innerHTML = [...groups.entries()].sort((a, b) => acctRank(a[0]) - acctRank(b[0])).map(([acct, rows]) => {
    const scored = rows.map((s) => ({ s, score: scoreFor(s.id), open: openCountFor(s.id) }))
      .sort((a, b) => a.score - b.score || b.open - a.open || storeNum(a.s) - storeNum(b.s));
    const withOpen = scored.filter((r) => r.open).length;
    return `<section class="group">
      <div class="group-head"><h2>${esc(acct)}</h2><span>${rows.length} store${rows.length === 1 ? '' : 's'}${withOpen ? ` · ${withOpen} with issues` : ''}</span></div>
      <div class="store-list">${scored.map(({ s, score, open }) => `
        <button class="store-row ${isActiveStore(s) ? '' : 'inactive'}" data-act="store" data-id="${esc(s.id)}">
          ${scoreBadge(score)}
          <div class="store-info">
            <div class="store-name">${esc(s.name)}</div>
            <div class="store-meta">${esc(city(s))}${isActiveStore(s) ? '' : ' · inactive'}</div>
          </div>
          <div class="store-right">
            <span class="count ${open ? 'has' : 'none'}">${open ? `${open} open` : 'Clear'}</span>
            <i class="ti ti-chevron-right" aria-hidden="true"></i>
          </div>
        </button>`).join('')}
      </div>
    </section>`;
  }).join('');
}

// ── ISSUES ────────────────────────────────────────────────────────────
function issueMatches(i) {
  if (state.pendingDelete?.id === i.id) return false;
  if (state.issueStatus === 'active' && !isOpen(i)) return false;
  if (state.issueStatus === 'in progress' && i.status !== 'in progress') return false;
  if (state.issueStatus === 'pending review' && i.status !== 'pending review') return false;
  if (state.issueStatus === 'resolved' && i.status !== 'resolved') return false;
  const s = state.byId.get(i.store_id);
  if (state.issueAccount && s?.account !== state.issueAccount) return false;
  if (state.issueCategory && i.category !== state.issueCategory) return false;
  if (state.issueSearch) {
    const q = state.issueSearch;
    if (![i.description, i.store_id, s?.name, s?.address, i.assignee].some((v) => String(v || '').toLowerCase().includes(q))) return false;
  }
  return true;
}

function renderIssues() {
  const list = $('issueList');
  if (!state.loaded) { list.innerHTML = loadingHTML('Loading issues…'); return; }
  const rows = visibleIssues().filter(issueMatches).sort(issueSort);
  $('issueCount').textContent = `${rows.length} issue${rows.length === 1 ? '' : 's'}`;
  const waiting = visibleIssues().filter((i) => i.status === 'pending review').length;
  const chip = $('reviewChip');
  chip.innerHTML = `Needs approval${waiting ? `<span class="n">${waiting}</span>` : ''}`;
  chip.classList.toggle('attention', isAdmin() && waiting > 0);
  const emptyMsg = {
    active: ['Nothing open', 'Every store is clear right now.'],
    'pending review': ['Nothing waiting for approval', 'Resolved issues show up here until an admin approves them.']
  }[state.issueStatus] || ['No issues match', 'Try another filter.'];
  list.innerHTML = rows.length ? rows.map((i) => issueCardHTML(i)).join('') : emptyHTML(...emptyMsg);
}

// Open first (oldest first among open), then most recent resolved.
function issueSort(a, b) {
  const ao = isOpen(a), bo = isOpen(b);
  if (ao !== bo) return ao ? -1 : 1;
  if (ao) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

const STATUS_LABEL = { open: 'Open', 'in progress': 'In progress', 'pending review': 'Needs approval', resolved: 'Resolved' };

function issueActions(i) {
  const a = [];
  if (i.status === 'open') a.push(`<button class="btn btn-sm" data-act="status" data-id="${i.id}" data-to="in progress">Start</button>`);
  if (i.status === 'open' || i.status === 'in progress')
    a.push(`<button class="btn btn-sm resolve" data-act="resolve" data-id="${i.id}"><i class="ti ti-check" aria-hidden="true"></i>Resolve</button>`);
  if (i.status === 'pending review' && isAdmin()) {
    a.push(`<button class="btn btn-sm approve" data-act="approve" data-id="${i.id}"><i class="ti ti-circle-check" aria-hidden="true"></i>Approve</button>`);
    a.push(`<button class="btn btn-sm" data-act="sendback" data-id="${i.id}">Send back</button>`);
  }
  if (i.status === 'resolved' && isAdmin()) a.push(`<button class="btn btn-sm" data-act="reopen" data-id="${i.id}">Reopen</button>`);
  if (i.status !== 'resolved') a.push(`<button class="btn btn-sm icon" data-act="edit" data-id="${i.id}" aria-label="Edit issue"><i class="ti ti-pencil" aria-hidden="true"></i></button>`);
  if (canDelete()) a.push(`<button class="btn btn-sm icon" data-act="delete" data-id="${i.id}" aria-label="Delete issue"><i class="ti ti-trash" aria-hidden="true"></i></button>`);
  return a.join('');
}

function fixLineHTML(i) {
  if (!i.resolution || !(i.status === 'pending review' || i.status === 'resolved')) return '';
  const who = i.resolved_by_name ? `${esc(i.resolved_by_name)}` : 'Someone';
  const when = i.resolved_at ? ` · ${esc(fmtDateTime(i.resolved_at))}` : '';
  const appr = i.status === 'resolved' && i.approved_by_name ? `<br><span>Approved by ${esc(i.approved_by_name)}${i.approved_at ? ' · ' + esc(fmtDateTime(i.approved_at)) : ''}</span>` : '';
  const wait = i.status === 'pending review' ? '<br><span>Waiting for an admin to approve</span>' : '';
  return `<div class="issue-fix"><b>Fixed by ${who}</b><span>${when}</span><br>${esc(i.resolution)}${appr}${wait}</div>`;
}

function issueCardHTML(i, { showPoints = false, showStore = true } = {}) {
  const s = state.byId.get(i.store_id);
  const age = daysSince(i.date);
  const open = isOpen(i);
  const statusCls = 'status-' + i.status.replace(' ', '-');
  const ageText = open ? (age === 0 ? 'Today' : `${age} day${age === 1 ? '' : 's'} open`) : `Logged ${fmtDate(i.date)}`;
  const pts = showPoints ? issuePoints(i) : 0;
  return `<article class="issue-card ${open ? '' : 'resolved'}">
    <button class="issue-open" data-act="issue" data-id="${i.id}" aria-label="Open issue details and comments">
      <div class="issue-top">
        ${showStore ? `<div class="issue-store">${esc(s?.name || i.store_id)} <small>${esc(city(s))}</small></div>` : `<div class="issue-store">${esc(fmtDate(i.date))}</div>`}
        <div class="issue-age ${open && age > 60 ? 'old' : ''}">${esc(ageText)}</div>
      </div>
      <div class="issue-tags">
        <span class="tag ${statusCls}">${esc(STATUS_LABEL[i.status] || cap(i.status))}</span>
        <span class="tag ${i.category === 'Safety' ? 'safety' : ''}">${esc(i.category)}</span>
        ${i.assignee ? `<span class="tag">${esc(i.assignee)}</span>` : ''}
        ${showPoints && pts ? `<span class="tag pts">${pts > 0 ? '−' + fmtPts(pts) : '+' + fmtPts(-pts)} pts</span>` : ''}
      </div>
      <p class="issue-desc">${esc(i.description)}</p>
      ${fixLineHTML(i)}
      <span class="issue-more"><i class="ti ti-message-circle" aria-hidden="true"></i>Details and comments</span>
    </button>
    <div class="issue-actions">${issueActions(i)}</div>
  </article>`;
}

// ── ISSUE DETAIL, COMMENTS, RESOLVE / APPROVE ─────────────────────────
let openIssueId = null;
const KIND_LABEL = { comment: 'commented', resolution: 'resolved it', approved: 'approved and closed it', sent_back: 'sent it back', reopened: 'reopened it' };

async function openIssue(id) {
  openIssueId = id;
  $('isComment').value = '';
  renderIssueSheet([]);
  openSheet('issueSheet');
  try { renderIssueSheet(await db.getComments(id)); }
  catch { renderIssueSheet(null); }
}

function renderIssueSheet(comments) {
  const i = state.issues.find((x) => x.id === openIssueId);
  if (!i) { closeSheet('issueSheet'); return; }
  const s = state.byId.get(i.store_id);
  $('isTitle').textContent = `${s?.name || i.store_id} · ${STATUS_LABEL[i.status] || cap(i.status)}`;
  $('isSub').textContent = `${city(s)} · ${i.category}`;
  const meta = [
    ['Logged', fmtDate(i.date) + (isOpen(i) ? ` · ${daysSince(i.date)} days ago` : '')],
    i.assignee ? ['Owner', i.assignee] : null,
    i.resolved_by_name ? ['Resolved by', `${i.resolved_by_name}${i.resolved_at ? ' · ' + fmtDateTime(i.resolved_at) : ''}`] : null,
    i.approved_by_name && i.status === 'resolved' ? ['Approved by', `${i.approved_by_name}${i.approved_at ? ' · ' + fmtDateTime(i.approved_at) : ''}`] : null
  ].filter(Boolean);
  const timeline = comments === null
    ? '<p class="section-note">Couldn\'t load comments. Close and reopen to try again.</p>'
    : comments.length
      ? `<div class="timeline">${comments.map((c) => `
          <div class="tl-item ${esc(c.kind)}">
            <div class="tl-head"><b>${esc(c.author_name || 'Someone')}</b> ${esc(KIND_LABEL[c.kind] || 'commented')} · ${esc(fmtDateTime(c.created_at))}</div>
            ${c.body ? `<div class="tl-body">${esc(c.body)}</div>` : ''}
          </div>`).join('')}</div>`
      : '<p class="section-note">No comments yet.</p>';
  $('isBody').innerHTML = `
    <p class="is-desc">${esc(i.description)}</p>
    <dl class="is-meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${i.resolution && i.status !== 'open' && i.status !== 'in progress' ? `<div class="issue-fix"><b>What was done</b><br>${esc(i.resolution)}</div>` : ''}
    <div class="is-actions issue-actions">${issueActions(i)}</div>
    <h3 class="section-title">Activity</h3>
    ${timeline}`;
}

async function refreshAfterChange(id) {
  await loadAll();
  rerender();
  if (openIssueId === id && $('issueSheet').classList.contains('open')) {
    try { renderIssueSheet(await db.getComments(id)); } catch { renderIssueSheet(null); }
  }
}

const NOTE_MODES = {
  resolve: {
    title: 'Resolve issue', label: 'What was done to fix it?', submit: 'Submit',
    placeholder: 'Re-scrubbed both stairways with deck brush, checked again at 5am. Crew briefed to do stairs nightly.',
    sub: () => isAdmin() ? 'As an admin, this closes the issue.' : 'An admin will review it before it is closed.'
  },
  sendback: {
    title: 'Send back', label: 'Why isn\'t it fixed yet?', submit: 'Send back',
    placeholder: 'Store says stairs by Pizza were still dirty this morning. Redo tonight.',
    sub: () => 'The issue goes back to In progress with your note.'
  },
  reopen: {
    title: 'Reopen issue', label: 'Why reopen it? (optional)', submit: 'Reopen',
    placeholder: 'Same problem reported again on Nov 12.',
    sub: () => 'The issue goes back to Open.'
  }
};
let noteState = null;

function openNote(mode, id) {
  const m = NOTE_MODES[mode];
  noteState = { mode, id };
  $('noteTitle').textContent = m.title;
  $('noteSub').textContent = m.sub();
  $('noteLabel').textContent = m.label;
  $('noteText').placeholder = m.placeholder;
  $('noteText').value = '';
  $('noteSubmit').textContent = m.submit;
  $('noteError').hidden = true;
  openSheet('noteSheet');
  setTimeout(() => $('noteText').focus(), 250);
}

async function submitNote() {
  if (!noteState) return;
  const { mode, id } = noteState;
  const text = $('noteText').value.trim();
  const err = $('noteError');
  if (mode === 'resolve' && text.length < 5) { err.textContent = 'Describe what was done to fix it.'; err.hidden = false; return; }
  if (mode === 'sendback' && text.length < 3) { err.textContent = 'Say why it is being sent back.'; err.hidden = false; return; }
  const btn = $('noteSubmit'); btn.disabled = true;
  try {
    if (mode === 'resolve') {
      const next = await db.resolveIssue(id, text);
      showToast(next === 'resolved' ? 'Resolved and closed' : 'Sent for approval');
    } else if (mode === 'sendback') {
      await db.reviewIssue(id, false, text);
      showToast('Sent back to In progress');
    } else {
      await db.reopenIssue(id, text);
      showToast('Issue reopened');
    }
    closeSheet('noteSheet');
    noteState = null;
    await refreshAfterChange(id);
  } catch (e) {
    err.textContent = friendlyDbError(e); err.hidden = false;
  }
  btn.disabled = false;
}

async function approveIssue(id) {
  try {
    await db.reviewIssue(id, true, '');
    showToast('Approved and closed');
    await refreshAfterChange(id);
  } catch (e) {
    showToast(friendlyDbError(e), { error: true });
  }
}

async function postComment(e) {
  e.preventDefault();
  const body = $('isComment').value.trim();
  if (!body || !openIssueId) return;
  const btn = $('isCommentBtn'); btn.disabled = true;
  try {
    await db.addComment(openIssueId, body);
    $('isComment').value = '';
    renderIssueSheet(await db.getComments(openIssueId));
  } catch (err) {
    showToast(friendlyDbError(err), { error: true });
  }
  btn.disabled = false;
}

function friendlyDbError(e) {
  const m = String(e?.message || '');
  if (/function .* does not exist|could not find the function/i.test(m)) return 'OpsBase needs a database update before this works. Ask your admin.';
  if (/Only an admin|Describe|Say why|already|not waiting|not closed|Write a comment|Use Resolve/i.test(m)) return m.replace(/^.*?:\s*/, '') + (m.endsWith('.') ? '' : '.');
  return "Couldn't save. Check your connection and try again.";
}

// ── STORE DETAIL ──────────────────────────────────────────────────────
function openStore(id) {
  if (!state.byId.has(id)) return;
  state.selectedId = id;
  switchScreen('detail');
}

function renderDetail() {
  const s = state.byId.get(state.selectedId);
  if (!s) { switchScreen('stores'); return; }
  const issues = issuesFor(s.id).filter((i) => state.pendingDelete?.id !== i.id).sort(issueSort);
  const score = healthScore(issues);
  const open = issues.filter(isOpen);
  const oldest = open.reduce((m, i) => Math.max(m, daysSince(i.date)), 0);

  $('detailTitle').textContent = s.name;
  $('detailSub').textContent = `${city(s)} · ${s.account}${isActiveStore(s) ? '' : ' · inactive'}`;
  $('detailScore').className = `score score-ring ${band(score)}`;
  $('detailScore').style.setProperty('--v', score);
  $('detailScore').innerHTML = `<span>${score}</span>`;
  $('detailScore').setAttribute('aria-label', `Health score ${score} out of 100`);

  const btn = $('detailActiveBtn');
  btn.hidden = !isAdmin();
  btn.textContent = isActiveStore(s) ? 'Mark inactive' : 'Mark active';
  btn.onclick = () => toggleStoreActive(s);

  $('detailStats').innerHTML = `
    <div class="stat ${open.length ? 'bad' : 'ok'}"><b>${open.length}</b><span>Open</span></div>
    <div class="stat"><b>${issues.length - open.length}</b><span>Resolved</span></div>
    <div class="stat ${oldest > 60 ? 'warn' : ''}"><b>${open.length ? oldest : '—'}</b><span>Oldest open, days</span></div>`;

  $('detailIssueList').innerHTML = issues.length
    ? issues.map((i) => issueCardHTML(i, { showPoints: true, showStore: false })).join('')
    : emptyHTML('No issues logged', 'Log one with the button above.');
}

// ── LOG / EDIT ────────────────────────────────────────────────────────
function populateLogStores() {
  const sel = $('logStoreId');
  const keep = sel.value;
  const editing = $('logEditId').value;
  const stores = state.stores.filter((s) => isActiveStore(s) || s.id === keep)
    .sort((a, b) => acctRank(a.account) - acctRank(b.account) || storeNum(a) - storeNum(b));
  const groups = new Map();
  stores.forEach((s) => { if (!groups.has(s.account)) groups.set(s.account, []); groups.get(s.account).push(s); });
  sel.innerHTML = '<option value="">Select store…</option>' + [...groups.entries()].map(([a, rows]) =>
    `<optgroup label="${esc(a)}">${rows.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(city(s))}</option>`).join('')}</optgroup>`).join('');
  sel.value = keep;
  $('logTitle').textContent = editing ? 'Edit issue' : 'Log issue';
  $('logSub').textContent = editing ? 'Change any field and save' : 'Report a store problem';
  $('logSubmitBtn').textContent = editing ? 'Save changes' : 'Log issue';
  $('logCancelBtn').hidden = !editing;
}

function resetLogForm() {
  $('logForm').reset();
  $('logEditId').value = '';
  $('logStoreId').value = '';
  $('logDate').value = today();
  $('logError').hidden = true;
  $('logStatusField').hidden = false;
}

function editIssue(id) {
  const i = state.issues.find((x) => x.id === id);
  if (!i) return;
  resetLogForm();
  $('logEditId').value = String(i.id);
  populateLogStores();
  $('logStoreId').value = i.store_id;
  $('logCategory').value = i.category;
  $('logDate').value = i.date;
  $('logDesc').value = i.description;
  const editableStatus = i.status === 'open' || i.status === 'in progress';
  $('logStatusField').hidden = !editableStatus;
  if (editableStatus) $('logStatus').value = i.status;
  $('logAssignee').value = i.assignee || '';
  switchScreen('log');
}

async function handleSaveIssue(e) {
  e.preventDefault();
  const storeId = $('logStoreId').value;
  const desc = $('logDesc').value.trim();
  if (!storeId || !desc) {
    const err = $('logError');
    err.textContent = !storeId ? 'Pick a store first.' : 'Describe what needs attention.';
    err.hidden = false;
    return;
  }
  const editId = Number($('logEditId').value) || null;
  const row = {
    store_id: storeId,
    category: $('logCategory').value,
    date: $('logDate').value || today(),
    description: desc,
    ...($('logStatusField').hidden ? {} : { status: $('logStatus').value }),
    assignee: $('logAssignee').value.trim() || null
  };
  const btn = $('logSubmitBtn');
  btn.disabled = true;
  try {
    if (editId) await db.updateIssue(editId, { ...row, updated_at: new Date().toISOString() });
    else await db.addIssue(row);
    showToast(editId ? 'Issue updated' : 'Issue logged');
    resetLogForm();
    await loadAll();
    state.selectedId = storeId;
    switchScreen('detail');
  } catch (err) {
    showToast("Couldn't save. Check your connection and try again.", { error: true });
  }
  btn.disabled = false;
}

// ── STATUS / DELETE ───────────────────────────────────────────────────
async function setStatus(id, to) {
  const i = state.issues.find((x) => x.id === id);
  if (!i) return;
  const from = i.status;
  i.status = to; rerender();
  try {
    await db.updateIssue(id, { status: to, updated_at: new Date().toISOString() });
    showToast(to === 'in progress' ? 'Marked in progress' : 'Moved back to Open', {
      action: 'Undo', onAction: () => setStatus(id, from)
    });
  } catch {
    i.status = from; rerender();
    showToast("Couldn't update. Try again.", { error: true });
  }
}

function deleteIssue(id) {
  commitPendingDelete();
  const i = state.issues.find((x) => x.id === id);
  if (!i) return;
  closeSheet('issueSheet');
  const timer = setTimeout(commitPendingDelete, 5000);
  state.pendingDelete = { id, timer };
  rerender();
  showToast('Issue deleted', { action: 'Undo', duration: 5000, onAction: () => {
    clearTimeout(timer); state.pendingDelete = null; rerender();
  } });
}

async function commitPendingDelete() {
  const p = state.pendingDelete;
  if (!p) return;
  clearTimeout(p.timer);
  state.pendingDelete = null;
  try {
    await db.deleteIssue(p.id);
    state.issues = state.issues.filter((x) => x.id !== p.id);
  } catch {
    showToast("Couldn't delete. Try again.", { error: true });
  }
  rerender();
}
window.addEventListener('pagehide', () => { if (state.pendingDelete) commitPendingDelete(); });

async function toggleStoreActive(s) {
  const next = !isActiveStore(s);
  try {
    await db.toggleActive(s.id, next);
    s.active = next;
    showToast(next ? `${s.name} marked active` : `${s.name} marked inactive`, { action: 'Undo', onAction: () => toggleStoreActive(s) });
    renderAccountControls();
    rerender();
  } catch {
    showToast("Couldn't update the store. Try again.", { error: true });
  }
}

async function handleAddStore() {
  const account = $('newStoreAccount').value;
  const num = $('newStoreNum').value.trim().replace(/^#/, '');
  const cityName = $('newStoreCity').value.trim();
  const st = $('newStoreState').value;
  const err = $('storeError');
  if (!num || !cityName) { err.textContent = 'Enter the store number and city.'; err.hidden = false; return; }
  err.hidden = true;
  const id = `${ACCOUNT_CODES[account] || 'XX'}-${num}`;
  try {
    await db.addStore({ id, name: `${account} #${num}`, account, state: st, address: `${cityName}, ${st}`, active: true });
    closeSheet('addStoreModal');
    ['newStoreNum', 'newStoreCity'].forEach((f) => { $(f).value = ''; });
    await loadAll();
    showToast(`${account} #${num} added`);
    rerender();
  } catch (e) {
    err.textContent = String(e.message || '').includes('duplicate') ? `Store ${id} already exists.` : "Couldn't add the store. Try again.";
    err.hidden = false;
  }
}

// ── REPORTS ───────────────────────────────────────────────────────────
let trendChart = null;

function periodIssues() {
  const base = state.issues.filter((i) => isActiveStore(state.byId.get(i.store_id)));
  if (state.reportPeriod === 'all') return base;
  const days = state.reportPeriod === 'week' ? 7 : 30;
  return base.filter((i) => daysSince(i.date) < days);
}

function renderReports() {
  if (!state.loaded) return;
  const issues = periodIssues();
  const label = { week: 'Last 7 days', month: 'Last 30 days', all: 'All time' }[state.reportPeriod];
  $('reportsSub').textContent = `${label} · ${issues.length} issue${issues.length === 1 ? '' : 's'} logged`;

  const openNow = state.issues.filter((i) => isOpen(i) && isActiveStore(state.byId.get(i.store_id))).length;
  $('reportKpis').innerHTML = `
    <div class="stat"><b>${issues.length}</b><span>Logged</span></div>
    <div class="stat ok"><b>${issues.filter((i) => i.status === 'resolved').length}</b><span>Of those resolved</span></div>
    <div class="stat ${openNow ? 'bad' : ''}"><b>${openNow}</b><span>Open now</span></div>`;

  const ranked = state.stores.filter(isActiveStore).map((s) => ({ s, score: scoreFor(s.id) }))
    .sort((a, b) => a.score - b.score || storeNum(a.s) - storeNum(b.s));
  $('reportRanking').innerHTML = ranked.map(({ s, score }) => `
    <button class="rank-row" data-act="store" data-id="${esc(s.id)}">
      <span class="rank-name">${esc(s.name)} <small>${esc(city(s))}</small></span>
      <span class="rank-val" style="color:var(--${band(score)})">${score}</span>
      <span class="rank-bar"><i style="width:${score}%;background:var(--${band(score)})"></i></span>
    </button>`).join('') || emptyHTML('No active stores');

  const cat = {};
  issues.forEach((i) => { cat[i.category] = (cat[i.category] || 0) + 1; });
  const max = Math.max(1, ...Object.values(cat));
  $('reportByCategory').innerHTML = Object.entries(cat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `
    <div class="bar-row"><span>${esc(c)}</span><span class="bar-track"><i style="width:${Math.round(n / max * 100)}%"></i></span><span class="bar-n">${n}</span></div>`).join('')
    || `<p class="section-note">No issues logged in this period.</p>`;

  renderTrend();
}

function renderTrend() {
  const canvas = $('trendChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const keys = [];
  for (let d = 13; d >= 0; d--) { const x = new Date(); x.setDate(x.getDate() - d); keys.push(x.toISOString().split('T')[0]); }
  const active = state.issues.filter((i) => isActiveStore(state.byId.get(i.store_id)));
  const logged = keys.map((k) => active.filter((i) => i.date === k).length);
  const resolved = keys.map((k) => active.filter((i) => i.status === 'resolved' && (i.approved_at || i.updated_at || '').slice(0, 10) === k).length);
  const labels = keys.map((k) => fmtDate(k));
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Logged', data: logged, backgroundColor: v('--warn'), borderRadius: 3 },
      { label: 'Resolved', data: resolved, backgroundColor: v('--ok'), borderRadius: 3 }
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: v('--muted'), boxWidth: 10, font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: v('--muted'), maxRotation: 0, autoSkip: true, maxTicksLimit: 7, font: { size: 11 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: v('--muted'), precision: 0, font: { size: 11 } }, grid: { color: v('--border') } }
      }
    }
  });
}

// ── HELPERS ───────────────────────────────────────────────────────────
function openSheet(id) { $(id).classList.add('open'); }
function closeSheet(id) { $(id).classList.remove('open'); }

let toastTimer = null;
function showToast(msg, { error = false, action = null, onAction = null, duration = 3500 } = {}) {
  const t = $('toast');
  $('toastMsg').textContent = msg;
  const b = $('toastAction');
  b.hidden = !action;
  b.textContent = action || '';
  b.onclick = () => { t.classList.remove('show'); onAction && onAction(); };
  t.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtPts = (n) => (Math.round(n * 10) / 10).toString();
function fmtDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const loadingHTML = (t) => `<div class="loading"><div class="spinner"></div>${esc(t)}</div>`;
const emptyHTML = (t, sub = '') => `<div class="empty"><b>${esc(t)}</b>${sub ? esc(sub) : ''}</div>`;
