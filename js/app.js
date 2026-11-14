import { db, auth } from './supabase.js';
import { healthScore, issuePoints, daysSince, isOpen, band } from './health.js';
import { pushState, turnOnPush, turnOffPush, telegramLink, telegramUnlink } from './notify.js';

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
  assignUser: null,
  tasks: [],
  taskLog: [],
  taskFilter: 'mine',
  calView: 'day',
  calDay: null,
  calStore: 'all'
};

const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', crew_lead: 'Crew lead', pending: 'Pending', disabled: 'Disabled' };
const STAFF = ['admin', 'supervisor', 'crew_lead'];
const isAdmin = () => state.me?.role === 'admin';
// Admin deletes anything; a supervisor only issues they logged. Recap- and admin-logged issues are admin-only.
const canDeleteIssue = (i) => state.me?.role === 'admin' || (state.me?.role === 'supervisor' && !!i.created_by && i.created_by === state.me?.id);
const canSeeUsers = () => ['admin', 'supervisor'].includes(state.me?.role);

const ACCOUNT_ORDER = ['Wegmans', 'Zara', 'Office Depot', 'Food Lion', 'Giant Food', 'Solidcore'];
const ACCOUNT_CODES = { 'Giant Food': 'GF', 'Wegmans': 'WM', 'Solidcore': 'SC', 'Food Lion': 'FL', 'Office Depot': 'OD', 'Zara': 'ZA' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const acctRank = (a) => { const i = ACCOUNT_ORDER.indexOf(a); return i < 0 ? 99 : i; };
const storeNum = (s) => parseInt(String(s.name).replace(/^\D+/, ''), 10) || 0;
const city = (s) => s?.address || s?.state || '';
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => isoLocal(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoLocal(d); };

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
    const params = new URLSearchParams(location.search);
    const want = params.get('screen');
    if (want === 'log') resetLogForm();
    switchScreen(['issues', 'log', 'reports', 'tasks', 'calendar'].includes(want) ? want : params.get('issue') ? 'issues' : 'stores');
    if (params.get('issue')) openIssue(Number(params.get('issue')));
    if (params.toString()) history.replaceState(null, '', location.pathname);
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
    ? 'Your CSMD access has been turned off. Contact Murod if you think this is a mistake.'
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
  return "Couldn't reach CSMD. Check your connection and try again.";
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
  $('pushBtn').addEventListener('click', togglePush);
  $('tgBtn').addEventListener('click', toggleTelegram);
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
  renderNotifySettings();
  openSheet('accountSheet');
}

async function renderNotifySettings() {
  const fresh = await db.myProfile(state.me.id).catch(() => null);
  if (fresh) state.me = { ...state.me, ...fresh };
  const st = await pushState().catch(() => 'unsupported');
  const msg = {
    on: 'On for this phone', off: 'Off for this phone', blocked: 'Blocked. Allow notifications for CSMD in your phone settings.',
    'install-first': 'On iPhone, first add CSMD to your Home Screen (Share → Add to Home Screen), then open it from there.',
    unsupported: 'This browser can’t show notifications.'
  }[st];
  $('pushStatus').textContent = msg;
  $('pushBtn').hidden = !(st === 'on' || st === 'off');
  $('pushBtn').textContent = st === 'on' ? 'Turn off' : 'Turn on';
  $('pushBtn').dataset.state = st;
  const linked = !!state.me.telegram_chat_id;
  $('tgStatus').textContent = linked ? 'Connected' : 'Not connected';
  $('tgBtn').textContent = linked ? 'Disconnect' : 'Connect';
  $('notifyHint').textContent = '';
}

async function togglePush() {
  const btn = $('pushBtn'); btn.disabled = true;
  try {
    if (btn.dataset.state === 'on') { await turnOffPush(); showToast('Phone pop-ups off'); }
    else { await turnOnPush(state.me.id); showToast('Phone pop-ups on'); }
  } catch (e) {
    $('notifyHint').textContent = e.message === 'blocked'
      ? 'Notifications were not allowed. Allow them for CSMD in your phone or browser settings.'
      : /push_subscriptions/.test(e.message) ? 'The database needs the notifications update first.' : 'Couldn’t turn on notifications. Try again.';
  }
  btn.disabled = false;
  renderNotifySettings();
}

async function toggleTelegram() {
  const btn = $('tgBtn'); btn.disabled = true;
  try {
    if (state.me.telegram_chat_id) {
      await telegramUnlink(); state.me.telegram_chat_id = null; showToast('Telegram disconnected');
    } else {
      const link = await telegramLink();
      location.href = link;
      $('notifyHint').textContent = 'Telegram opened. Tap Start there, then come back. It shows Connected next time you open this.';
    }
  } catch (e) {
    $('notifyHint').textContent = e.message === 'bot' ? 'Telegram isn’t set up yet on the server.' : 'Couldn’t connect Telegram. Try again.';
  }
  btn.disabled = false;
  if (state.me.telegram_chat_id === null) renderNotifySettings();
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
        ${(p.role === 'crew_lead' || p.role === 'supervisor') && isAdmin() ? `<button class="btn btn-sm" data-act="assign" data-id="${esc(p.id)}"><i class="ti ti-building-store" aria-hidden="true"></i>Stores</button>` : ''}
      </div>
      ${p.role === 'crew_lead' ? `<div class="user-stores">${stores.length ? `<b>${stores.length} store${stores.length === 1 ? '' : 's'}:</b> ${esc(stores.join(', '))}` : 'No stores assigned yet, so they see nothing.'}</div>` : ''}
      ${p.role === 'supervisor' ? `<div class="user-stores">${stores.length ? `<b>Covers ${stores.length} store${stores.length === 1 ? '' : 's'}:</b> ${esc(stores.join(', '))}` : 'No stores set. They see all stores, but get no new-issue alerts and no store tasks from emails.'}</div>` : ''}
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
  $('assignSub').textContent = p.role === 'supervisor'
    ? 'The stores this supervisor covers. They still see every store; these decide their new-issue alerts and which email tasks go to them.'
    : 'Pick the stores this crew lead can see.';
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
    const [stores, issues, tasks, taskLog, profiles, assignments] = await Promise.all([
      db.getStores(), db.getIssues(),
      db.getTasks().catch(() => []),
      db.getTaskLog().catch(() => []),
      canSeeUsers() ? db.getProfiles().catch(() => []) : Promise.resolve([]),
      db.getAssignments().catch(() => null)
    ]);
    if (assignments) state.assignments = assignments;
    state.stores = stores;
    state.issues = issues;
    state.tasks = tasks;
    state.taskLog = taskLog;
    if (profiles.length) state.profiles = profiles;
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
  chipGroup('taskChips', (v) => { state.taskFilter = v; renderTasks(); });
  $('taskCancel').addEventListener('click', () => closeSheet('taskSheet'));
  $('taskSave').addEventListener('click', saveTask);
  $('newTaskBtn').addEventListener('click', () => openTaskSheet(null));
  $('taskRepeat').addEventListener('change', syncRepeatFields);
  $('taskNthWeek').addEventListener('change', syncRepeatFields);
  $('taskNthDay').addEventListener('change', syncRepeatFields);
  chipGroup('calViewChips', (v) => { state.calView = v; renderCalendar(); });
  $('calPrev').addEventListener('click', () => calStep(-1));
  $('calNext').addEventListener('click', () => calStep(1));
  $('calToday').addEventListener('click', () => { state.calDay = today(); renderCalendar(); });
  $('calStore').addEventListener('change', (e) => { state.calStore = e.target.value; renderCalendar(); });
  $('calNewBtn').addEventListener('click', () => openTaskSheet(null, null, { due: state.calDay || today(), storeId: calStoreForNew(), job: true }));
  $('calImportBtn').addEventListener('click', openImport);
  $('impCancel').addEventListener('click', () => closeSheet('importSheet'));
  $('impRead').addEventListener('click', readImport);
  $('impSave').addEventListener('click', saveImport);
  $('impStore').addEventListener('change', pickImportAssignee);
  $('impRows').addEventListener('input', onImportEdit);
  $('impRows').addEventListener('change', onImportEdit);
  $('taskDue').addEventListener('change', syncRepeatFields);
  $('taskUntil').addEventListener('change', syncRepeatFields);
  $('taskDays').addEventListener('click', (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    b.classList.toggle('on'); syncRepeatFields();
  });
  $('taskUntilField').addEventListener('click', (e) => {
    const b = e.target.closest('[data-until]'); if (!b) return;
    const n = b.dataset.until;
    $('taskUntil').value = n ? addDays($('taskDue').value || today(), Number(n) - 1) : '';
    syncRepeatFields();
  });

  $('logForm').addEventListener('submit', handleSaveIssue);
  $('logDesc').addEventListener('input', () => { $('logError').hidden = true; });
  $('logStoreId').addEventListener('change', () => { $('logError').hidden = true; });
  $('logCancelBtn').addEventListener('click', () => { const back = state.selectedId ? 'detail' : 'issues'; resetLogForm(); switchScreen(back); });

  $('addStoreBtn').addEventListener('click', () => openSheet('addStoreModal'));
  $('cancelStore').addEventListener('click', () => closeSheet('addStoreModal'));
  $('saveStoreBtn').addEventListener('click', handleAddStore);
  document.querySelectorAll('.sheet-overlay').forEach((el) => el.addEventListener('click', (e) => { if (e.target === el) closeSheet(el.id); }));

  $('brandBtn').addEventListener('click', () => {
    if (!state.me || document.body.classList.contains('signed-out')) return;
    document.querySelectorAll('.sheet-overlay.open').forEach((el) => closeSheet(el.id));
    state.selectedId = null;
    switchScreen('stores');
  });
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
    else if (act === 'invalid') openNote('invalid', Number(id));
    else if (act === 'edit') editIssue(Number(id));
    else if (act === 'delete') deleteIssue(Number(id));
    else if (act === 'assign') openAssign(id);
    else if (act === 'addtask') openTaskSheet(Number(id));
    else if (act === 'taskdone') openNote('task', Number(id));
    else if (act === 'taskreopen') reopenTask(Number(id));
    else if (act === 'taskdelete') deleteTask(Number(id));
    else if (act === 'taskedit') openTaskSheet(null, Number(id));
    else if (act === 'logapprove') approveTaskLog(Number(id));
    else if (act === 'logsendback') openNote('tasksendback', Number(id));
    else if (act === 'logissue') openNote('taskissue', Number(id), logIssueText(Number(id)));
    else if (act === 'logfollow') followUpFromLog(Number(id));
    else if (act === 'calday') calPickDay(id);
    else if (act === 'calnew') openTaskSheet(null, null, { due: id, storeId: calStoreForNew(), job: true });
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
const SCREENS = { stores: 'scStores', issues: 'scIssues', log: 'scLog', detail: 'scDetail', reports: 'scReports', auth: 'scAuth', pending: 'scPending', users: 'scUsers', tasks: 'scTasks', calendar: 'scCalendar' };
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
  else if (name === 'tasks') renderTasks();
  else if (name === 'calendar') renderCalendar();
  window.scrollTo({ top: 0 });
}

function rerender() {
  renderHeader();
  if (state.screen === 'stores') renderStores();
  else if (state.screen === 'issues') renderIssues();
  else if (state.screen === 'detail') renderDetail();
  else if (state.screen === 'reports') renderReports();
  else if (state.screen === 'tasks') renderTasks();
  else if (state.screen === 'calendar') renderCalendar();
}

// ── HEADER & ACCOUNT CONTROLS ─────────────────────────────────────────
function renderHeader() {
  const active = state.stores.filter(isActiveStore);
  const open = state.issues.filter((i) => isOpen(i) && isActiveStore(state.byId.get(i.store_id))).length;
  $('headerStats').innerHTML = `<span><b>${active.length}</b> stores</span><span class="${open ? 'warn' : ''}"><b>${open}</b> open</span>`;
  const badge = $('navBadge');
  badge.hidden = !open;
  badge.textContent = open > 99 ? '99+' : String(open);
  const mineDue = myOpenTasks().filter((t) => !t.due_date || t.due_date <= today()).length + (isAdmin() ? approvalQueue().length + taskReviewQueue().length : 0);
  const tb = $('taskBadge');
  tb.hidden = !mineDue;
  tb.textContent = String(mineDue);
  const jobs = myJobsDue().length;
  $('calBadge').hidden = !jobs;
  $('calBadge').textContent = String(jobs);
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
  if (state.issueStatus === 'not valid' && i.status !== 'not valid') return false;
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

const STATUS_LABEL = { open: 'Open', 'in progress': 'In progress', 'pending review': 'Needs approval', resolved: 'Resolved', 'not valid': 'Not valid' };

function issueActions(i) {
  const a = [];
  if (i.status === 'open') a.push(`<button class="btn btn-sm" data-act="status" data-id="${i.id}" data-to="in progress">Start</button>`);
  if (i.status === 'open' || i.status === 'in progress')
    a.push(`<button class="btn btn-sm resolve" data-act="resolve" data-id="${i.id}"><i class="ti ti-check" aria-hidden="true"></i>Resolve</button>`);
  if (i.status === 'pending review' && isAdmin()) {
    a.push(`<button class="btn btn-sm approve" data-act="approve" data-id="${i.id}"><i class="ti ti-circle-check" aria-hidden="true"></i>Approve</button>`);
    a.push(`<button class="btn btn-sm" data-act="sendback" data-id="${i.id}">Send back</button>`);
    a.push(`<button class="btn btn-sm icon" data-act="addtask" data-id="${i.id}" aria-label="Add follow-up" title="Add follow-up"><i class="ti ti-calendar-plus" aria-hidden="true"></i></button>`);
  }
  if ((i.status === 'resolved' || i.status === 'not valid') && isAdmin()) a.push(`<button class="btn btn-sm" data-act="reopen" data-id="${i.id}">Reopen</button>`);
  if (i.status !== 'resolved' && i.status !== 'not valid' && !(i.status === 'pending review' && isAdmin())) a.push(`<button class="btn btn-sm icon" data-act="edit" data-id="${i.id}" aria-label="Edit issue"><i class="ti ti-pencil" aria-hidden="true"></i></button>`);
  if (canDeleteIssue(i)) a.push(`<button class="btn btn-sm icon" data-act="delete" data-id="${i.id}" aria-label="Delete issue"><i class="ti ti-trash" aria-hidden="true"></i></button>`);
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
const KIND_LABEL = { comment: 'commented', resolution: 'resolved it', approved: 'approved and closed it', sent_back: 'sent it back', reopened: 'reopened it', invalid: 'marked it not valid' };

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
    i.approved_by_name && i.status === 'not valid' ? ['Marked not valid', `${i.approved_by_name}${i.approved_at ? ' · ' + fmtDateTime(i.approved_at) : ''}`] : null,
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
    ${isAdmin() && i.status !== 'not valid' && i.status !== 'resolved' ? `<button class="is-invalid-link" data-act="invalid" data-id="${i.id}">Not valid? Store was mistaken</button>` : ''}
    ${followUpsHTML(i)}
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
  task: {
    title: 'Finish task', label: 'What did you find or do? (optional)', submit: 'Mark done',
    placeholder: 'Tabitha confirmed the freezer floor looks good.',
    sub: () => 'Your note is added to the issue\'s activity.'
  },
  tasksendback: {
    title: 'Send task back', label: 'What still needs to be done?', submit: 'Send back',
    placeholder: 'Drains still have buildup. Redo tonight and send a photo.',
    sub: () => 'It goes back on their list for the same day, with your note.'
  },
  taskissue: {
    title: 'Make it an issue', label: 'Describe the problem', submit: 'Log issue',
    placeholder: 'Bakery floor drains still clogged after the nightly scrub.',
    sub: () => 'This logs a new open issue for the store. The task is closed.'
  },
  invalid: {
    title: 'Mark not valid', label: 'Why is it not valid?', submit: 'Mark not valid',
    placeholder: 'Block Whitener is on the approved chemicals list. Store was mistaken.',
    sub: () => 'It stays on record but costs the store no health points. Its open follow-ups are closed.'
  },
  reopen: {
    title: 'Reopen issue', label: 'Why reopen it? (optional)', submit: 'Reopen',
    placeholder: 'Same problem reported again on Nov 12.',
    sub: () => 'The issue goes back to Open.'
  }
};
let noteState = null;

function openNote(mode, id, prefill = '') {
  const m = NOTE_MODES[mode];
  noteState = { mode, id };
  $('noteCatField').hidden = mode !== 'taskissue';
  $('noteTitle').textContent = m.title;
  $('noteSub').textContent = m.sub();
  $('noteLabel').textContent = m.label;
  $('noteText').placeholder = m.placeholder;
  $('noteText').value = prefill;
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
  if ((mode === 'sendback' || mode === 'tasksendback' || mode === 'invalid') && text.length < 3) { err.textContent = 'Say why it is being sent back.'; err.hidden = false; return; }
  if (mode === 'taskissue' && text.length < 5) { err.textContent = 'Describe the problem.'; err.hidden = false; return; }
  const btn = $('noteSubmit'); btn.disabled = true;
  try {
    if (mode === 'resolve') {
      const next = await db.resolveIssue(id, text);
      showToast(next === 'resolved' ? 'Resolved and closed' : 'Sent for approval');
    } else if (mode === 'task') {
      await db.completeTask(id, text);
      closeSheet('noteSheet'); noteState = null;
      const t = state.tasks.find((x) => x.id === id);
      const rep = t && t.repeat && t.repeat !== 'none';
      showToast(isAdmin() ? (rep ? 'Done. It moves to the next date.' : 'Task done') : `Sent for approval${rep ? '. It moves to the next date.' : ''}`);
      await refreshAfterChange(t?.issue_id ?? -1);
      btn.disabled = false;
      return;
    } else if (mode === 'tasksendback' || mode === 'taskissue') {
      const newIssue = await db.reviewTask(id, mode === 'taskissue' ? 'issue' : 'sendback', text, $('noteCat').value);
      closeSheet('noteSheet'); noteState = null;
      await refreshAfterChange(-1);
      if (mode === 'taskissue') showToast('Issue logged', { action: 'Open', onAction: () => openIssue(Number(newIssue)), duration: 6000 });
      else showToast('Sent back');
      btn.disabled = false;
      return;
    } else if (mode === 'invalid') {
      await db.invalidateIssue(id, text);
      showToast('Marked not valid');
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
    await refreshAfterChange(id);
    showToast('Approved and closed', { action: 'Add follow-up', onAction: () => openTaskSheet(id), duration: 8000 });
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
  if (/function .* does not exist|could not find the function/i.test(m)) return 'CSMD needs a database update before this works. Ask your admin.';
  if (/relation .*tasks.* does not exist|could not find the table/i.test(m)) return 'Tasks need a database update first. Ask your admin.';
  if (/Only an admin|Only the person|Describe|Say why|already|not waiting|not closed|Write a comment|Use Resolve|Task not found/i.test(m)) return m.replace(/^.*?:\s*/, '') + (m.endsWith('.') ? '' : '.');
  return "Couldn't save. Check your connection and try again.";
}

// ── FOLLOW-UP TASKS ──────────────────────────────────────────────────
// Fixes waiting for an admin to approve; shown at the top of an admin's Tasks tab.
const approvalQueue = () => state.issues.filter((i) => i.status === 'pending review' && isActiveStore(state.byId.get(i.store_id)))
  .sort((a, b) => (a.resolved_at || a.date || '').localeCompare(b.resolved_at || b.date || ''));
// Task completions by the team, waiting for an admin.
const taskReviewQueue = () => state.taskLog.filter((l) => l.review === 'pending' && state.tasks.some((t) => t.id === l.task_id))
  .sort((a, b) => a.done_at.localeCompare(b.done_at));
// Floor care jobs live on the Calendar; everything else is a follow-up task on the Tasks tab.
const isJob = (t) => t.source === 'calendar';
const myOpenTasks = () => state.tasks.filter((t) => !isJob(t) && t.status === 'open' && t.assignee_id === state.me?.id);
const myJobsDue = () => state.tasks.filter((t) => isJob(t) && t.status === 'open' && t.assignee_id === state.me?.id && t.due_date && t.due_date <= today());

function dueInfo(t) {
  if (!t.due_date) return { text: 'No due date', cls: '' };
  const d = Math.round((new Date(t.due_date + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
  if (t.status === 'done') return { text: `Due ${fmtDate(t.due_date)}`, cls: '' };
  if (d < 0) return { text: `${-d} day${d === -1 ? '' : 's'} overdue`, cls: 'overdue' };
  if (d === 0) return { text: 'Due today', cls: 'today' };
  if (d === 1) return { text: 'Due tomorrow', cls: '' };
  return { text: `Due ${fmtDate(t.due_date)}`, cls: '' };
}

function taskCardHTML(t) {
  const s = state.byId.get(t.store_id);
  const due = dueInfo(t);
  const issue = t.issue_id ? state.issues.find((i) => i.id === t.issue_id) : null;
  const canFinish = t.assignee_id === state.me?.id || canSeeUsers();
  const actions = t.status === 'open'
    ? (canFinish ? `<button class="btn btn-sm resolve" data-act="taskdone" data-id="${t.id}"><i class="ti ti-check" aria-hidden="true"></i>Done</button>` : '')
    : `<button class="btn btn-sm" data-act="taskreopen" data-id="${t.id}">Undo</button>`;
  const sentBack = t.status === 'open' && /^Sent back: /.test(t.done_note || '');
  return `<article class="task-card ${due.cls === 'overdue' ? 'overdue' : ''} ${t.status === 'done' ? 'done' : ''}">
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-actions">${actions}${isAdmin() ? `<button class="btn btn-sm icon" data-act="taskedit" data-id="${t.id}" aria-label="Edit task"><i class="ti ti-pencil" aria-hidden="true"></i></button><button class="btn btn-sm icon" data-act="taskdelete" data-id="${t.id}" aria-label="Delete task"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}</div>
    <div class="task-meta">
      <span class="task-due ${due.cls}">${esc(t.status === 'done' ? `Done ${t.done_at ? fmtDateTime(t.done_at) : ''}` : t.status === 'pending review' ? 'Waiting for approval' : due.text)}</span>
      ${s ? `<span>· ${esc(s.name)} ${esc(city(s))}</span>` : ''}
      ${state.taskFilter !== 'mine' || t.assignee_id !== state.me?.id ? `<span>· ${esc(t.assignee_name || 'Unassigned')}</span>` : ''}
      ${t.repeat && t.repeat !== 'none' ? `<span class="tag repeat"><i class="ti ti-repeat" aria-hidden="true"></i> ${esc(repeatText(t))}</span>` : ''}
      ${t.source === 'email' ? '<span class="tag">From email</span>' : ''}
      ${t.status === 'done' && t.done_note ? `<span>· ${esc(t.done_note)}</span>` : ''}
    </div>
    ${sentBack ? `<div class="task-sentback">${esc(t.done_note)}</div>` : ''}
    ${t.status === 'open' && t.last_done_at && !sentBack ? `<div class="task-last">Last done ${esc(fmtDateTime(t.last_done_at))}${t.last_done_by_name ? ' by ' + esc(t.last_done_by_name) : ''}${t.done_note ? ' · ' + esc(t.done_note) : ''}</div>` : ''}
    ${issue ? `<button class="task-link" data-act="issue" data-id="${issue.id}">Open issue: ${esc(issue.description.slice(0, 70))}${issue.description.length > 70 ? '…' : ''}</button>` : ''}
  </article>`;
}

function renderTasks() {
  $('taskAllChip').hidden = !canSeeUsers();
  $('newTaskBtn').hidden = !isAdmin();
  if (!canSeeUsers() && state.taskFilter === 'all') state.taskFilter = 'mine';
  $('taskChips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.taskFilter));
  const list = $('taskList');
  let rows;
  if (state.taskFilter === 'done') rows = state.taskLog.length ? state.taskLog
    : state.tasks.filter((t) => !isJob(t) && t.status === 'done' && (canSeeUsers() || t.assignee_id === state.me?.id))
      .sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
  else rows = state.tasks.filter((t) => !isJob(t) && (t.status === 'open' || (t.status === 'pending review' && !isAdmin())) && (state.taskFilter === 'all' || t.assignee_id === state.me?.id))
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  const overdue = rows.filter((t) => t.status === 'open' && dueInfo(t).cls === 'overdue').length;
  const approvals = state.taskFilter !== 'done' && isAdmin() ? approvalQueue() : [];
  const reviews = state.taskFilter !== 'done' && isAdmin() ? taskReviewQueue() : [];
  const toApprove = approvals.length + reviews.length;
  $('tasksSub').textContent = state.taskFilter === 'done' ? `${rows.length} finished`
    : `${toApprove ? `${toApprove} to approve · ` : ''}${rows.length} open${overdue ? ` · ${overdue} overdue` : ''}`;
  const approvalHTML = toApprove
    ? `<div class="task-group warn">Needs your approval</div>${reviews.map(reviewCardHTML).join('')}${approvals.map((i) => issueCardHTML(i)).join('')}` : '';
  if (!rows.length) {
    list.innerHTML = approvalHTML + (toApprove && state.taskFilter !== 'done'
      ? '<div class="task-group">Follow-ups</div><p class="task-empty">No open follow-ups.</p>'
      : emptyHTML(state.taskFilter === 'done' ? 'Nothing finished yet' : 'No follow-ups', state.taskFilter === 'mine' ? 'Tasks assigned to you show up here.' : ''));
    return;
  }
  if (state.taskFilter === 'done') { list.innerHTML = state.taskLog.length ? doneLogHTML() : rows.map(taskCardHTML).join(''); return; }
  const late = rows.filter((t) => dueInfo(t).cls === 'overdue');
  const rest = rows.filter((t) => dueInfo(t).cls !== 'overdue');
  list.innerHTML = approvalHTML
    + (late.length ? `<div class="task-group bad">Overdue</div>${late.map(taskCardHTML).join('')}` : '')
    + (rest.length ? `${late.length || toApprove ? `<div class="task-group">${late.length ? 'Coming up' : 'Follow-ups'}</div>` : ''}${rest.map(taskCardHTML).join('')}` : '');
}

// A team member's "done" waiting for the admin: approve, send back, make an issue, or add a follow-up.
function reviewCardHTML(l) {
  const t = state.tasks.find((x) => x.id === l.task_id);
  const s = state.byId.get(t.store_id);
  return `<article class="task-card review">
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">
      <span class="task-due today">Done ${esc(fmtDateTime(l.done_at))}</span>
      ${l.done_by_name ? `<span>· ${esc(l.done_by_name)}</span>` : ''}
      ${s ? `<span>· ${esc(s.name)} ${esc(city(s))}</span>` : ''}
      ${t.repeat && t.repeat !== 'none' ? `<span class="tag repeat"><i class="ti ti-repeat" aria-hidden="true"></i> ${esc(repeatText(t))}</span>` : ''}
    </div>
    ${l.note ? `<div class="issue-fix"><b>Their note</b><br>${esc(l.note)}</div>` : ''}
    ${t.issue_id ? `<button class="task-link" data-act="issue" data-id="${t.issue_id}">Open linked issue</button>` : ''}
    <div class="review-actions">
      <button class="btn btn-sm approve" data-act="logapprove" data-id="${l.id}"><i class="ti ti-circle-check" aria-hidden="true"></i>Approve</button>
      <button class="btn btn-sm" data-act="logsendback" data-id="${l.id}">Send back</button>
      <button class="btn btn-sm" data-act="logissue" data-id="${l.id}"><i class="ti ti-alert-circle" aria-hidden="true"></i>Make issue</button>
      <button class="btn btn-sm" data-act="logfollow" data-id="${l.id}"><i class="ti ti-calendar-plus" aria-hidden="true"></i>Follow-up</button>
    </div>
  </article>`;
}

function logIssueText(logId) {
  const l = state.taskLog.find((x) => x.id === logId);
  const t = l && state.tasks.find((x) => x.id === l.task_id);
  return t ? `${t.title}${l.note ? ` — ${l.note}` : ''}` : '';
}

function followUpFromLog(logId) {
  const l = state.taskLog.find((x) => x.id === logId);
  const t = l && state.tasks.find((x) => x.id === l.task_id);
  if (t) openTaskSheet(t.issue_id || null, null, { storeId: t.store_id });
}

async function approveTaskLog(logId) {
  const l = state.taskLog.find((x) => x.id === logId);
  try {
    await db.reviewTask(logId, 'approve');
    await refreshAfterChange(-1);
    showToast('Approved', { action: 'Add follow-up', onAction: () => followUpFromLog(logId), duration: 8000 });
  } catch (e) {
    showToast(/review_task|function/i.test(e.message) ? 'The database needs the task-approval update first (migration 007).' : friendlyDbError(e), { error: true });
  }
  return l;
}

const REVIEW_TAG = { pending: ['Waiting for approval', 'warn'], approved: ['Approved', 'ok'], sent_back: ['Sent back', 'bad'], issue: ['Became an issue', 'bad'] };

// Every time a task was finished, newest first. Undo only on a one-time task's last finish.
function doneLogHTML() {
  const latest = new Map();
  state.taskLog.forEach((l) => { if (!latest.has(l.task_id)) latest.set(l.task_id, l.id); });
  return state.taskLog.map((l) => {
    const t = state.tasks.find((x) => x.id === l.task_id);
    if (!t) return '';
    const s = state.byId.get(t.store_id);
    const undo = (t.status === 'done' || t.status === 'pending review') && latest.get(t.id) === l.id && (isAdmin() || l.review === 'pending')
      ? `<button class="btn btn-sm" data-act="taskreopen" data-id="${t.id}">Undo</button>` : '';
    return `<article class="task-card done">
      <div class="log-row"><div class="task-title">${esc(t.title)}</div><div class="task-actions">${undo}</div></div>
      <div class="task-meta">
        <span class="task-due">Done ${esc(fmtDateTime(l.done_at))}</span>
        ${l.done_by_name ? `<span>· ${esc(l.done_by_name)}</span>` : ''}
        ${l.review && REVIEW_TAG[l.review] ? `<span class="tag rv-${REVIEW_TAG[l.review][1]}">${REVIEW_TAG[l.review][0]}</span>` : ''}
        ${s ? `<span>· ${esc(s.name)} ${esc(city(s))}</span>` : ''}
        ${l.due_date && t.repeat !== 'none' ? `<span>· for ${esc(fmtDate(l.due_date))}</span>` : ''}
        ${l.note ? `<span>· ${esc(l.note)}</span>` : ''}
      </div>
      ${l.review_note && l.review !== 'approved' ? `<div class="task-last">${esc(l.reviewed_by_name || 'Admin')}: ${esc(l.review_note)}</div>` : ''}
    </article>`;
  }).join('');
}

function followUpsHTML(issue) {
  const tasks = state.tasks.filter((t) => t.issue_id === issue.id);
  if (!tasks.length && !isAdmin()) return '';
  return `<h3 class="section-title">Follow-ups</h3>
    <div class="is-tasks">
      ${tasks.map((t) => `<div class="is-task ${t.status === 'done' ? 'done' : ''}"><div>${esc(t.title)}<br><span>${esc(t.assignee_name || 'Unassigned')} · ${esc(t.status === 'done' ? 'Done' : dueInfo(t).text)}</span></div>
        ${t.status === 'open' && (t.assignee_id === state.me?.id || canSeeUsers()) ? `<button class="btn btn-sm resolve" data-act="taskdone" data-id="${t.id}">Done</button>` : ''}</div>`).join('')}
      ${isAdmin() ? `<button class="btn btn-sm" data-act="addtask" data-id="${issue.id}"><i class="ti ti-plus" aria-hidden="true"></i>Add follow-up</button>` : ''}
    </div>`;
}

let taskIssueId = null, taskEditId = null, taskIsJob = false;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

function repeatText(t) {
  const until = t.repeat_until ? ` until ${fmtDate(t.repeat_until)}` : '';
  if (t.repeat === 'daily') return `Every day${until}`;
  if (t.repeat === 'weekly') {
    const days = [...(t.repeat_days || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const label = days.length === 5 && !days.includes(0) && !days.includes(6) ? 'weekday' : days.map((d) => DAY_NAMES[d]).join(', ');
    return `Every ${label}${until}`;
  }
  if (t.repeat === 'monthly') return `Monthly on the ${ordinal(t.repeat_days?.[0] || Number((t.due_date || today()).slice(8)))}${until}`;
  if (t.repeat === 'monthly_nth') return `Every ${WEEK_WORDS[t.repeat_days?.[0]] || ''} ${DAY_NAMES[t.repeat_days?.[1]] || ''} of the month${until}`;
  return '';
}

function repeatDaysFor(r, due) {
  if (r === 'weekly') return pickedDays();
  if (r === 'monthly') return [Number(due.slice(8))];
  if (r === 'monthly_nth') return [Number($('taskNthWeek').value), Number($('taskNthDay').value)];
  return null;
}

// Start date → the first date the task really comes due on its pattern.
function firstDue(r, due, days) {
  if (r === 'weekly' && !days.includes(dowOf(due))) {
    for (let k = 1; k <= 7; k++) { const d = addDays(due, k); if (days.includes(dowOf(d))) return d; }
  }
  if (r === 'monthly_nth') {
    const x = nthWeekday(due, days[0], days[1]);
    return x >= due ? x : nthWeekday(addMonths(due, 1), days[0], days[1]);
  }
  return due;
}

function pickedDays() { return [...$('taskDays').querySelectorAll('.on')].map((b) => Number(b.dataset.d)); }

function syncRepeatFields() {
  const r = $('taskRepeat').value;
  $('taskDaysField').hidden = r !== 'weekly';
  $('taskNthField').hidden = r !== 'monthly_nth';
  $('taskUntilField').hidden = r === 'none';
  $('taskDueLabel').textContent = r === 'none' ? 'Due' : 'Starts';
  const due = $('taskDue').value || today();
  if (r === 'weekly' && !pickedDays().length) {
    const b = $('taskDays').querySelector(`[data-d="${new Date(due + 'T00:00:00').getDay()}"]`); b && b.classList.add('on');
  }
  const preview = { repeat: r, repeat_days: repeatDaysFor(r, due), repeat_until: $('taskUntil').value || null, due_date: due };
  $('taskRepeatHint').textContent = r === 'none' ? '' : repeatText(preview) + (preview.repeat_until ? '' : ' (no end date)');
}

function openTaskSheet(issueId, editId = null, opts = {}) {
  const t = editId ? state.tasks.find((x) => x.id === editId) : null;
  if (editId && !t) return;
  const i = state.issues.find((x) => x.id === (t ? t.issue_id : issueId));
  taskIssueId = i ? i.id : null;
  taskEditId = t ? t.id : null;
  taskIsJob = t ? isJob(t) : !!opts.job;
  $('taskSheetTitle').textContent = t ? (taskIsJob ? 'Edit job' : 'Edit task') : i ? 'Add follow-up' : taskIsJob ? 'New floor care job' : 'New task';
  $('taskSave').textContent = t ? 'Save' : i ? 'Add follow-up' : taskIsJob ? 'Add to calendar' : 'Add task';
  const s = i ? state.byId.get(i.store_id) : null;
  $('taskSheetSub').textContent = i ? `${s?.name || i.store_id} · ${i.description.slice(0, 80)}${i.description.length > 80 ? '…' : ''}` : (taskIsJob ? 'Shows on the Calendar. One time, or repeating for stores that do the same areas every month.' : 'A task for one of your stores, one time or repeating.');
  $('taskStoreField').hidden = !!i;
  if (!i) {
    const stores = state.stores.filter(isActiveStore);
    $('taskStore').innerHTML = '<option value="">No specific store</option>' + stores.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(city(x))}</option>`).join('');
    $('taskStore').value = t?.store_id || opts.storeId || (state.screen === 'detail' ? state.selectedId || '' : '');
  }
  $('taskTitle').value = t?.title || '';
  const staff = state.profiles.filter((p) => STAFF.includes(p.role))
    .sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
  $('taskAssignee').innerHTML = staff.map((p) => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)} · ${esc(ROLE_LABEL[p.role])}</option>`).join('')
    || '<option value="">No team members yet</option>';
  if (t?.assignee_id) $('taskAssignee').value = t.assignee_id;
  $('taskDue').value = t?.due_date || opts.due || (i ? addDays(today(), 1) : today());
  const dueNow = $('taskDue').value;
  $('taskNthWeek').value = String(t?.repeat === 'monthly_nth' ? t.repeat_days[0] : nthOf(dueNow));
  $('taskNthDay').value = String(t?.repeat === 'monthly_nth' ? t.repeat_days[1] : dowOf(dueNow));
  $('taskRepeat').value = t?.repeat || 'none';
  $('taskUntil').value = t?.repeat_until || '';
  $('taskDays').querySelectorAll('[data-d]').forEach((b) => b.classList.toggle('on', t?.repeat === 'weekly' && (t.repeat_days || []).includes(Number(b.dataset.d))));
  syncRepeatFields();
  $('taskError').hidden = true;
  openSheet('taskSheet');
}

async function saveTask() {
  const title = $('taskTitle').value.trim();
  const who = $('taskAssignee').value;
  const err = $('taskError');
  const repeat = $('taskRepeat').value;
  const due = $('taskDue').value || today();
  const until = repeat === 'none' ? null : $('taskUntil').value || null;
  const days = repeatDaysFor(repeat, due);
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (title.length < 3) return fail('Say what needs to happen.');
  if (!who) return fail('Pick who it is for. Team members appear here once they have a role.');
  if (repeat === 'weekly' && !days.length) return fail('Pick at least one day.');
  if (until && until < due) return fail('The end date is before the start date.');
  const first = firstDue(repeat, due, days);
  if (until && first > until) return fail('With this pattern the first date is after the end date.');
  const p = state.profiles.find((x) => x.id === who);
  const i = state.issues.find((x) => x.id === taskIssueId);
  const fields = {
    title, assignee_id: who, assignee_name: p?.full_name || p?.email || '',
    due_date: first, repeat, repeat_days: days, repeat_until: until,
    store_id: i ? i.store_id : $('taskStore').value || null
  };
  const btn = $('taskSave'); btn.disabled = true;
  try {
    if (taskEditId) await db.updateTask(taskEditId, fields);
    else await db.addTask({ ...fields, issue_id: taskIssueId, source: taskIsJob ? 'calendar' : 'manual', created_by: state.me.id, created_by_name: state.me.full_name || state.me.email });
    closeSheet('taskSheet');
    showToast(taskEditId ? 'Saved' : taskIsJob ? `Added to the calendar${repeat === 'none' ? '' : ', repeating'}` : `${repeat === 'none' ? 'Task' : 'Repeating task'} added for ${p?.full_name || p?.email}`);
    await refreshAfterChange(taskIssueId ?? -1);
  } catch (e) {
    fail(/repeat|column|source|check constraint/i.test(e.message) ? `The database needs an update first (migration ${repeat === 'monthly_nth' || taskIsJob ? '012' : '006'}).` : friendlyDbError(e));
  }
  btn.disabled = false;
}

async function reopenTask(id) {
  try { await db.reopenTask(id); await loadAll(); rerender(); showToast('Task reopened'); }
  catch (e) { showToast(friendlyDbError(e), { error: true }); }
}

async function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  try {
    await db.deleteTask(id);
    showToast('Task deleted');
    await refreshAfterChange(t?.issue_id ?? -1);
  } catch (e) { showToast(friendlyDbError(e), { error: true }); }
}

// ── CALENDAR ──────────────────────────────────────────────────────────
// Every store's tasks by day: one-time tasks on their due date, repeating tasks on every
// date they come due, and finished ones from the done log.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK_WORDS = ['', '1st', '2nd', '3rd', '4th', 'last'];
const dowOf = (iso) => new Date(iso + 'T00:00:00').getDay();
const monthStart = (iso) => iso.slice(0, 8) + '01';
const monthEnd = (iso) => { const [y, m] = iso.split('-').map(Number); return isoLocal(new Date(y, m, 0)); };
const addMonths = (iso, n) => { const [y, m] = iso.split('-').map(Number); return isoLocal(new Date(y, m - 1 + n, 1)); };
const weekStartOf = (iso) => addDays(iso, -((dowOf(iso) + 6) % 7)); // weeks start Monday

// The Nth (1–4) or last (5) weekday of the month containing iso.
function nthWeekday(iso, wk, dow) {
  const first = monthStart(iso), last = monthEnd(iso);
  if (wk >= 5) return addDays(last, -((dowOf(last) - dow + 7) % 7));
  return addDays(first, ((dow - dowOf(first) + 7) % 7) + (wk - 1) * 7);
}
const nthOf = (iso) => { const d = Number(iso.slice(8)); return addDays(iso, 7) > monthEnd(iso) && d > 28 ? 5 : Math.ceil(d / 7); };

// The next date a repeating task comes due strictly after iso (matches task_next_due in the database).
function nextOccurrence(t, iso) {
  let d = null;
  if (t.repeat === 'daily') d = addDays(iso, 1);
  else if (t.repeat === 'weekly') {
    const days = t.repeat_days || [];
    if (!days.length) return null;
    for (let k = 1; k <= 7; k++) { const x = addDays(iso, k); if (days.includes(dowOf(x))) { d = x; break; } }
  } else if (t.repeat === 'monthly') {
    const dom = t.repeat_days?.[0] || Number((t.due_date || iso).slice(8));
    let m = monthStart(iso);
    for (let k = 0; k < 13; k++) {
      const end = monthEnd(m);
      const x = m.slice(0, 8) + String(dom).padStart(2, '0');
      const pick = x > end ? end : x;
      if (pick > iso) { d = pick; break; }
      m = addMonths(m, 1);
    }
  } else if (t.repeat === 'monthly_nth') {
    const [wk, dow] = t.repeat_days || [];
    if (!wk && wk !== 0) return null;
    let m = monthStart(iso);
    for (let k = 0; k < 13; k++) { const x = nthWeekday(m, wk, dow); if (x > iso) { d = x; break; } m = addMonths(m, 1); }
  }
  if (!d || (t.repeat_until && d > t.repeat_until)) return null;
  return d;
}

// Admins see every store. Everyone else sees the stores they are assigned to,
// plus anything assigned to them. A supervisor with no stores set still sees all.
function myStoreIds() {
  if (isAdmin()) return null;
  const mine = state.assignments.filter((a) => a.user_id === state.me?.id).map((a) => a.store_id);
  if (!mine.length && state.me?.role === 'supervisor') return null;
  return new Set(mine);
}
const calStores = () => { const mine = myStoreIds(); return state.stores.filter((s) => isActiveStore(s) && (!mine || mine.has(s.id))); };

function calVisible(t) {
  const mine = myStoreIds();
  if (mine && t.assignee_id !== state.me?.id && !(t.store_id && mine.has(t.store_id))) return false;
  return calStoreMatch(t.store_id);
}

function calStoreMatch(storeId) {
  const f = state.calStore;
  const s = storeId ? state.byId.get(storeId) : null;
  if (f === 'all') return !s || isActiveStore(s) || state.showInactive;
  if (f === 'none') return !storeId;
  if (f.startsWith('acct:')) return !!s && s.account === f.slice(5);
  return storeId === f;
}

// Everything on the calendar between two dates, inclusive.
// kind: overdue | due | upcoming | pending | done
function calItems(from, to) {
  const out = [];
  const now = today();
  const loggedDates = new Map();
  for (const l of state.taskLog) {
    const t = state.tasks.find((x) => x.id === l.task_id);
    if (!t || !isJob(t) || !calVisible(t)) continue;
    const date = l.due_date || isoLocal(new Date(l.done_at));
    if (!loggedDates.has(t.id)) loggedDates.set(t.id, new Set());
    loggedDates.get(t.id).add(date);
    if (t.repeat === 'none' || date < from || date > to) continue;
    out.push({ date, t, l, kind: l.review === 'pending' ? 'pending' : 'done' });
  }
  for (const t of state.tasks) {
    if (!t.due_date || !isJob(t) || !calVisible(t)) continue;
    if (t.repeat === 'none') {
      if (t.due_date < from || t.due_date > to) continue;
      const kind = t.status === 'done' ? 'done' : t.status === 'pending review' ? 'pending' : t.due_date < now ? 'overdue' : t.due_date === now ? 'due' : 'upcoming';
      out.push({ date: t.due_date, t, kind, current: t.status === 'open' });
      continue;
    }
    if (t.status !== 'open') continue;
    let d = t.due_date, guard = 0;
    while (d && d <= to && guard++ < 400) {
      if (d >= from && !(d !== t.due_date && loggedDates.get(t.id)?.has(d))) {
        const current = d === t.due_date;
        out.push({ date: d, t, current, kind: d < now && current ? 'overdue' : d === now && current ? 'due' : 'upcoming' });
      }
      d = nextOccurrence(t, d);
    }
  }
  const rank = { overdue: 0, due: 1, upcoming: 2, pending: 3, done: 4 };
  return out.sort((a, b) => a.date.localeCompare(b.date) || rank[a.kind] - rank[b.kind] || a.t.title.localeCompare(b.t.title));
}

function renderCalendarFilter() {
  const sel = $('calStore');
  const stores = calStores().sort((a, b) => acctRank(a.account) - acctRank(b.account) || storeNum(a) - storeNum(b));
  const accounts = [...new Set(stores.map((s) => s.account))].sort((a, b) => acctRank(a) - acctRank(b));
  sel.innerHTML = `<option value="all">${myStoreIds() ? 'All my stores' : 'All stores'}</option>`
    + accounts.map((a) => `<option value="acct:${esc(a)}">All ${esc(a)}</option>`).join('')
    + '<option value="none">Not tied to a store</option>'
    + accounts.map((a) => `<optgroup label="${esc(a)}">${stores.filter((s) => s.account === a).map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(city(s))}</option>`).join('')}</optgroup>`).join('');
  sel.value = [...sel.options].some((o) => o.value === state.calStore) ? state.calStore : 'all';
  state.calStore = sel.value;
}

function renderCalendar() {
  if (!state.calDay) state.calDay = today();
  $('calNewBtn').hidden = !isAdmin();
  $('calImportBtn').hidden = !isAdmin();
  renderCalendarFilter();
  $('calViewChips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.val === state.calView));
  const day = state.calDay;
  if (state.calView === 'day') { renderCalendarDay(day); return; }
  let from, to;
  if (state.calView === 'week') {
    from = weekStartOf(day); to = addDays(from, 6);
    const sameMonth = from.slice(5, 7) === to.slice(5, 7);
    $('calTitle').textContent = `${fmtDate(from)} – ${sameMonth ? Number(to.slice(8)) : fmtDate(to)}`;
  } else {
    from = weekStartOf(monthStart(day)); to = addDays(weekStartOf(monthEnd(day)), 6);
    $('calTitle').textContent = `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
  }
  const items = calItems(from, to);
  const byDate = new Map();
  items.forEach((it) => { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); });
  const inMonth = state.calView === 'week' ? items : items.filter((it) => it.date.slice(0, 7) === day.slice(0, 7));
  const late = inMonth.filter((it) => it.kind === 'overdue').length;
  const open = inMonth.filter((it) => it.kind === 'due' || it.kind === 'upcoming' || it.kind === 'overdue').length;
  const done = inMonth.filter((it) => it.kind === 'done').length;
  $('calSub').textContent = `${open} to do${late ? ` · ${late} overdue` : ''}${done ? ` · ${done} done` : ''}`;

  if (state.calView === 'week') {
    const days = Array.from({ length: 7 }, (_, k) => addDays(from, k));
    $('calGrid').innerHTML = '';
    $('calGrid').hidden = true;
    $('calAgenda').innerHTML = days.map((d) => calDayHTML(d, byDate.get(d) || [], { compactEmpty: true })).join('');
    return;
  }
  $('calGrid').hidden = false;
  const oneStore = !!calStoreForNew();
  $('calGrid').classList.toggle('one-store', oneStore);
  const head = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => `<div class="cal-dow">${n}</div>`).join('');
  let cells = '';
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const list = byDate.get(d) || [];
    const other = d.slice(0, 7) !== day.slice(0, 7);
    const todo = list.filter((it) => it.kind !== 'done' && it.kind !== 'pending');
    const bad = list.some((it) => it.kind === 'overdue');
    const allDone = list.length && !todo.length;
    const max = oneStore ? 6 : 2;
    const labels = list.slice(0, max).map((it) => `<span class="cal-lbl k-${it.kind}">${esc(it.t.title)}</span>`).join('');
    const more = list.length > max ? `<span class="cal-more">+${list.length - max}</span>` : '';
    const count = list.length ? `<span class="cal-count ${bad ? 'bad' : allDone ? 'ok' : ''}">${allDone ? '<i class="ti ti-check" aria-hidden="true"></i>' : todo.length}</span>` : '';
    cells += `<button class="cal-cell${other ? ' other' : ''}${d === today() ? ' today' : ''}${d === day ? ' sel' : ''}" data-act="calday" data-id="${d}"
      aria-label="${esc(fmtDate(d))}: ${list.length ? `${todo.length} to do, ${list.length - todo.length} done` : 'nothing'}">
      <span class="cal-num">${Number(d.slice(8))}</span>${count}<span class="cal-lbls">${labels}${more}</span></button>`;
  }
  $('calGrid').innerHTML = head + cells;
  $('calAgenda').innerHTML = calDayHTML(day, byDate.get(day) || []);
}

const CAL_KIND = { overdue: ['Overdue', 'bad'], due: ['Due today', 'warn'], upcoming: ['', ''], pending: ['Waiting for approval', 'warn'], done: ['Done', 'ok'] };

function calDayHTML(d, list, { compactEmpty = false } = {}) {
  const label = new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const add = isAdmin() ? `<button class="btn btn-sm icon" data-act="calnew" data-id="${d}" aria-label="Add a job on ${esc(label)}"><i class="ti ti-plus" aria-hidden="true"></i></button>` : '';
  const head = `<div class="cal-day-head${d === today() ? ' today' : ''}"><span>${esc(label)}${d === today() ? ' · Today' : ''}</span>${add}</div>`;
  if (!list.length) return head + (compactEmpty ? '' : '<p class="task-empty">Nothing scheduled.</p>');
  return head + list.map(calItemHTML).join('');
}

function calItemHTML(it, { hideStore = false, showDate = false } = {}) {
  const { t, kind } = it;
  const s = state.byId.get(t.store_id);
  const [kLabel, kCls] = CAL_KIND[kind];
  // Only the task's current date can be finished; later repeats unlock once that one is done.
  const canFinish = it.current && (t.assignee_id === state.me?.id || canSeeUsers() || (state.me?.role === 'crew_lead' && !!s));
  const who = kind === 'done' || kind === 'pending' ? (it.l?.done_by_name || t.done_by_name || t.assignee_name) : t.assignee_name;
  return `<article class="cal-item k-${kind}">
    <div class="cal-item-main">
      <div class="task-title">${esc(t.title)}</div>
      <div class="task-meta">
        ${kLabel ? `<span class="task-due ${kCls === 'bad' ? 'overdue' : kCls === 'warn' ? 'today' : ''}">${esc(kLabel)}${showDate ? ` · ${esc(fmtDate(it.date))}` : ''}</span>` : ''}
        ${s && !hideStore ? `<span>${kLabel ? '· ' : ''}${esc(s.name)} ${esc(city(s))}</span>` : ''}
        ${who ? `<span>${kLabel || (s && !hideStore) ? '· ' : ''}${esc(who)}</span>` : ''}
        ${t.repeat && t.repeat !== 'none' ? `<span class="tag repeat"><i class="ti ti-repeat" aria-hidden="true"></i> ${esc(repeatText(t))}</span>` : ''}
        ${it.l?.note ? `<span>· ${esc(it.l.note)}</span>` : ''}
      </div>
    </div>
    <div class="task-actions">
      ${canFinish ? `<button class="btn btn-sm resolve" data-act="taskdone" data-id="${t.id}"><i class="ti ti-check" aria-hidden="true"></i>Done</button>` : ''}
      ${isAdmin() && kind !== 'done' ? `<button class="btn btn-sm icon" data-act="taskedit" data-id="${t.id}" aria-label="Edit task"><i class="ti ti-pencil" aria-hidden="true"></i></button>` : ''}
    </div>
  </article>`;
}

function calStep(n) {
  const d = state.calDay || today();
  if (state.calView === 'day') state.calDay = addDays(d, n);
  else if (state.calView === 'week') state.calDay = addDays(d, 7 * n);
  else {
    const m = addMonths(d, n);
    const want = m.slice(0, 8) + d.slice(8);
    state.calDay = want > monthEnd(m) ? monthEnd(m) : want;
  }
  renderCalendar();
}

// Tapping a day in the month grid opens that day.
function calPickDay(d) {
  state.calDay = d;
  state.calView = 'day';
  renderCalendar();
  window.scrollTo({ top: 0 });
}

// Day view (the default): anything overdue first, then the day's jobs grouped by store.
function renderCalendarDay(day) {
  const now = today();
  const label = new Date(day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  $('calTitle').textContent = day === now ? 'Today' : day === addDays(now, 1) ? 'Tomorrow' : day === addDays(now, -1) ? 'Yesterday' : label.split(',')[0];
  const list = calItems(day, day);
  const late = day === now ? calItems('2000-01-01', addDays(now, -1)).filter((it) => it.kind === 'overdue') : [];
  const todo = list.filter((it) => it.kind !== 'done' && it.kind !== 'pending').length;
  const done = list.length - todo;
  $('calSub').textContent = `${day === now || day === addDays(now, 1) || day === addDays(now, -1) ? label + ' · ' : ''}${todo} job${todo === 1 ? '' : 's'}${late.length ? ` · ${late.length} overdue` : ''}${done ? ` · ${done} done` : ''}`;
  $('calGrid').innerHTML = '';
  $('calGrid').hidden = true;
  let html = '';
  if (late.length) {
    html += `<div class="cal-day-head bad"><span>Overdue · ${late.length}</span></div>` + late.map((it) => calItemHTML(it, { showDate: true })).join('');
  }
  const add = isAdmin() ? `<button class="btn btn-sm icon" data-act="calnew" data-id="${day}" aria-label="Add a job on ${esc(label)}"><i class="ti ti-plus" aria-hidden="true"></i></button>` : '';
  if (!list.length) {
    html += `<div class="cal-day-head"><span>${late.length ? (day === now ? 'Today' : label) : ''}</span>${add}</div><p class="task-empty">No floor care jobs ${day === now ? 'today' : 'this day'}.</p>`;
  } else {
    const groups = new Map();
    list.forEach((it) => { const k = it.t.store_id || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); });
    const keys = [...groups.keys()].sort((a, b) => {
      const sa = state.byId.get(a), sb = state.byId.get(b);
      return (sa ? acctRank(sa.account) : 99) - (sb ? acctRank(sb.account) : 99) || (sa ? storeNum(sa) : 0) - (sb ? storeNum(sb) : 0);
    });
    keys.forEach((k, n) => {
      const s = state.byId.get(k);
      const g = groups.get(k);
      const left = g.filter((it) => it.kind !== 'done' && it.kind !== 'pending').length;
      html += `<div class="cal-store-head"><span><b>${esc(s ? s.name : 'No store')}</b>${s ? ` · ${esc(city(s))}` : ''}</span><span class="cal-store-count">${left ? `${left} to do` : 'All done'}</span>${n === 0 ? add : ''}</div>`
        + g.map((it) => calItemHTML(it, { hideStore: true })).join('');
    });
  }
  $('calAgenda').innerHTML = html;
}

// The store for a new task started from the calendar: the one being filtered on, if any.
const calStoreForNew = () => (state.calStore && !state.calStore.startsWith('acct:') && !['all', 'none'].includes(state.calStore) ? state.calStore : '');

// ── IMPORT A STORE'S MONTHLY CALENDAR ─────────────────────────────────
// Stores like Allentown #79 email a month grid: a day number, then the areas for that day.
// Lines next to each other belong together; a blank line starts a new task.
function parseMonthCalendar(text, ym) {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const WEEKDAY = /^(sun|mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur)(day)?\.?$/i;
  const STOP = /^(thank you|thanks|regards|best regards|sincerely|sent from)/i;
  const out = [];
  let day = 0, buf = [];
  const flush = () => {
    const title = buf.reduce((acc, x) => (acc && !/\/$/.test(acc) ? `${acc} ${x}` : acc + x), '').replace(/\s+/g, ' ').replace(/\s+([&/])\s*$/, '').trim();
    const date = `${ym}-${String(day).padStart(2, '0')}`;
    // Store hours notes and days already past start unchecked.
    if (day && title) out.push({ date, title: tidyTitle(title), keep: date >= today() && !/^store (opens|closes|closed|open)\b/i.test(title) });
    buf = [];
  };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const cells = raw.includes('\t') ? raw.split('\t') : [raw];
    for (const c of cells) {
      const l = c.replace(/\[[^\]]*\]/g, '').replace(/ |﻿/g, ' ').trim();
      if (!l) { flush(); continue; }
      if (STOP.test(l)) { flush(); return out; }
      if (WEEKDAY.test(l)) { flush(); continue; }
      const n = l.match(/^(\d{1,2})(?:[.):\-]?\s+(.+))?$/);
      if (n && Number(n[1]) >= 1 && Number(n[1]) <= days && Number(n[1]) > day) {
        flush(); day = Number(n[1]);
        if (n[2]) buf.push(n[2]);
        continue;
      }
      if (day) {
        // "Seafood Cooler &" + "Seafood/Prepared Freezer" → one task
        buf.push(l);
      }
    }
  }
  flush();
  return out;
}

// SHOUTING CAPS → Normal case, keeping short codes like "IVR".
function tidyTitle(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4 || letters !== letters.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s/&(-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

let importRows = [];

async function openImport() {
  const stores = state.stores.filter(isActiveStore).sort((a, b) => acctRank(a.account) - acctRank(b.account) || storeNum(a) - storeNum(b));
  $('impStore').innerHTML = '<option value="">Pick a store</option>' + stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(city(s))}</option>`).join('');
  $('impStore').value = calStoreForNew();
  const now = today();
  $('impMonth').value = (Number(now.slice(8)) >= 20 ? addMonths(now, 1) : now).slice(0, 7);
  const staff = state.profiles.filter((p) => STAFF.includes(p.role)).sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
  $('impWho').innerHTML = staff.map((p) => `<option value="${esc(p.id)}">${esc(p.full_name || p.email)} · ${esc(ROLE_LABEL[p.role])}</option>`).join('') || '<option value="">No team members yet</option>';
  $('impText').value = '';
  importRows = [];
  renderImportRows();
  $('impError').hidden = true;
  openSheet('importSheet');
  if (!state.assignments.length) { try { state.assignments = await db.getAssignments(); } catch { /* optional */ } }
  pickImportAssignee();
}

// Default "Who" to the supervisor who covers the store.
function pickImportAssignee() {
  const sid = $('impStore').value;
  const sup = state.assignments.map((a) => a.store_id === sid && state.profiles.find((p) => p.id === a.user_id && p.role === 'supervisor')).find(Boolean);
  if (sup) $('impWho').value = sup.id;
}

function readImport() {
  const ym = $('impMonth').value;
  if (!ym) { $('impError').textContent = 'Pick the month.'; $('impError').hidden = false; return; }
  importRows = parseMonthCalendar($('impText').value, ym);
  $('impError').hidden = !!importRows.length || !$('impText').value.trim();
  if (!importRows.length && $('impText').value.trim()) $('impError').textContent = "Couldn't find any days. Paste the calendar part of the email, starting at day 1.";
  renderImportRows();
}

function renderImportRows() {
  const box = $('impRows');
  const n = importRows.filter((r) => r.keep).length;
  $('impSave').textContent = n ? `Add ${n} task${n === 1 ? '' : 's'}` : 'Add tasks';
  $('impSave').disabled = !n;
  if (!importRows.length) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="field-label">Check the list. Uncheck or fix any line before adding.</div><div class="imp-row imp-head"><span></span><span>Day</span><span>Task</span></div>` + importRows.map((r, k) => `
    <div class="imp-row${r.keep ? '' : ' off'}">
      <input type="checkbox" data-imp="keep" data-k="${k}" ${r.keep ? 'checked' : ''} aria-label="Add this one">
      <input type="number" inputmode="numeric" min="1" max="31" data-imp="day" data-k="${k}" value="${Number(r.date.slice(8))}" aria-label="Day of the month">
      <input type="text" data-imp="title" data-k="${k}" value="${esc(r.title)}" aria-label="Task">
    </div>`).join('');
}

function onImportEdit(e) {
  const el = e.target.closest('[data-imp]'); if (!el) return;
  const r = importRows[Number(el.dataset.k)]; if (!r) return;
  if (el.dataset.imp === 'keep') { r.keep = el.checked; el.closest('.imp-row').classList.toggle('off', !r.keep); renderImportRowsCount(); }
  else if (el.dataset.imp === 'day') r.date = `${r.date.slice(0, 8)}${String(Math.max(1, Math.min(31, Number(el.value) || 1))).padStart(2, '0')}`;
  else r[el.dataset.imp] = el.value;
}
function renderImportRowsCount() {
  const n = importRows.filter((r) => r.keep).length;
  $('impSave').textContent = n ? `Add ${n} task${n === 1 ? '' : 's'}` : 'Add tasks';
  $('impSave').disabled = !n;
}

async function saveImport() {
  const err = $('impError');
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  const sid = $('impStore').value, who = $('impWho').value;
  if (!sid) return fail('Pick the store this calendar is for.');
  if (!who) return fail('Pick who does these.');
  const p = state.profiles.find((x) => x.id === who);
  const have = new Set(state.tasks.filter((t) => t.store_id === sid).map((t) => `${t.due_date}|${t.title.toLowerCase()}`));
  const ym = $('impMonth').value;
  if (!ym) return fail('Pick the month.');
  importRows.forEach((r) => { r.date = ym + r.date.slice(7); });
  const rows = importRows.filter((r) => r.keep && r.title.trim().length >= 2 && r.date <= monthEnd(ym + '-01'))
    .filter((r) => !have.has(`${r.date}|${r.title.trim().toLowerCase()}`));
  if (!rows.length) return fail('These are already on the calendar.');
  const base = { store_id: sid, assignee_id: who, assignee_name: p?.full_name || p?.email || '', repeat: 'none', repeat_days: null, repeat_until: null,
    created_by: state.me.id, created_by_name: state.me.full_name || state.me.email };
  const btn = $('impSave'); btn.disabled = true;
  try {
    await db.addTask(rows.map((r) => ({ ...base, title: r.title.trim(), due_date: r.date, source: 'calendar' })));
    const monthName = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
    db.notifyCalendarImport(who, sid, rows.length, monthName).catch(() => { /* alert is optional */ });
    closeSheet('importSheet');
    state.calStore = sid;
    state.calView = 'month';
    state.calDay = rows[0].date;
    await refreshAfterChange(-1);
    showToast(`${rows.length} task${rows.length === 1 ? '' : 's'} added to ${state.byId.get(sid)?.name || 'the store'}`);
  } catch (e) { fail(/source|check constraint/i.test(e.message) ? 'The database needs the calendar update first (migration 012).' : friendlyDbError(e)); }
  btn.disabled = false;
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
  } catch (e) {
    showToast(/not allowed/.test(e?.message) ? 'Only an admin can delete this issue.' : "Couldn't delete. Try again.", { error: true });
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
  const base = state.issues.filter((i) => i.status !== 'not valid' && isActiveStore(state.byId.get(i.store_id)));
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
