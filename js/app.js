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
  taskStore: 'all',
  taskDue: 'any', // 'any' | 'today' | 'overdue' — works with Mine / Everyone
  calView: 'day',
  calDay: null,
  calStore: 'all',
  audits: []
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
// "3900 W Tilghman St, Allentown, PA 18104" → "Allentown, PA" for lists; the full address shows on the store page.
const city = (s) => {
  const a = s?.address || '';
  const m = a.match(/,\s*([^,]+),\s*([A-Z]{2})\b[^,]*$/);
  return m ? `${m[1].trim()}, ${m[2]}` : a || s?.state || '';
};
const hasStreet = (s) => /^\d/.test(s?.address || '');
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
    $('pinStoresBtn').hidden = !isAdmin();
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
    const [stores, issues, tasks, taskLog, profiles, assignments, audits] = await Promise.all([
      db.getStores(), db.getIssues(),
      db.getTasks().catch(() => []),
      db.getTaskLog().catch(() => []),
      canSeeUsers() ? db.getProfiles().catch(() => []) : Promise.resolve([]),
      db.getAssignments().catch(() => null),
      ['admin', 'supervisor'].includes(state.me?.role) ? db.getAudits().catch(() => []) : Promise.resolve([])
    ]);
    if (assignments) state.assignments = assignments;
    state.audits = audits;
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
  // Mine / Everyone / Done pick whose tasks; Due today / Overdue narrow them (tap again to clear).
  const onTaskChip = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.due) {
      state.taskDue = state.taskDue === chip.dataset.due ? 'any' : chip.dataset.due;
      if (state.taskFilter === 'done') state.taskFilter = canSeeUsers() ? 'all' : 'mine';
    } else {
      state.taskFilter = chip.dataset.val;
      if (state.taskFilter === 'done') state.taskDue = 'any';
    }
    renderTasks();
  };
  $('taskChips').addEventListener('click', onTaskChip);
  $('taskDueChips').addEventListener('click', onTaskChip);
  $('taskStoreFilter').addEventListener('change', (e) => { state.taskStore = e.target.value; renderTasks(); });
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
  $('detailAuditBtn').addEventListener('click', () => openAuditStart(state.selectedId));
  $('auditStartGo').addEventListener('click', startAudit);
  $('auditStartCancel').addEventListener('click', () => closeSheet('auditStartSheet'));
  $('auditForm').addEventListener('input', onAuditInput);
  $('auditForm').addEventListener('change', onAuditPhotos);
  $('auditBack').addEventListener('click', async () => { await auditSaveNow(); backToStore(); });
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
  $('pinStoresBtn').addEventListener('click', pinAllStores);
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
    else if (act === 'auditopen') openAudit(Number(id));
    else if (act === 'auditans') { const [q, v] = id.split('|'); auditAnswer(q, /^\d$/.test(v) ? Number(v) : v); }
    else if (act === 'auditphotodel') auditPhotoDelete(id);
    else if (act === 'auditphotoview') window.open(auditUrls.get(id), '_blank', 'noopener');
    else if (act === 'auditsubmit') submitAudit();
    else if (act === 'auditdelete') deleteAudit();
    else if (act === 'auditpdf') auditPdf();
    else if (act === 'locfind') storeLocFind(id);
    else if (act === 'lochere') storeLocHere(id);
    else if (act === 'locpaste') storeLocPaste(id);
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
const SCREENS = { stores: 'scStores', issues: 'scIssues', log: 'scLog', detail: 'scDetail', reports: 'scReports', auth: 'scAuth', pending: 'scPending', users: 'scUsers', tasks: 'scTasks', calendar: 'scCalendar', audit: 'scAudit' };
function switchScreen(name) {
  state.screen = name;
  Object.entries(SCREENS).forEach(([k, id]) => $(id).classList.toggle('active', k === name));
  const navName = name === 'detail' || name === 'users' ? 'stores' : name === 'audit' ? 'stores' : name;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.screen === navName));
  if (name === 'stores') renderStores();
  else if (name === 'issues') renderIssues();
  else if (name === 'log') populateLogStores();
  else if (name === 'detail') renderDetail();
  else if (name === 'reports') renderReports();
  else if (name === 'users') renderUsers();
  else if (name === 'tasks') renderTasks();
  else if (name === 'calendar') renderCalendar();
  else if (name === 'audit') renderAuditForm();
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

// Tasks tab due filter: 'today' = due today, 'overdue' = past due.
const taskDueOk = (t) => state.taskDue === 'any' || (t.status === 'open' && dueInfo(t).cls === state.taskDue);

// Tasks tab store filter: 'all', 'none' (not tied to a store), or a store id.
const taskStoreOk = (storeId) => state.taskStore === 'all' || (state.taskStore === 'none' ? !storeId : storeId === state.taskStore);

function renderTaskStoreFilter() {
  const sel = $('taskStoreFilter');
  // Only stores that have something to show under the chip picked (Mine / Everyone / Done).
  const mine = (t) => state.taskFilter !== 'mine' || t.assignee_id === state.me?.id;
  const count = new Map();
  const add = (sid) => count.set(sid || '', (count.get(sid || '') || 0) + 1);
  if (state.taskFilter === 'done') {
    (state.taskLog.length ? state.taskLog.map((l) => state.tasks.find((t) => t.id === l.task_id)) : state.tasks.filter((t) => t.status === 'done'))
      .filter((t) => t && !isJob(t) && (canSeeUsers() || t.assignee_id === state.me?.id)).forEach((t) => add(t.store_id));
  } else {
    state.tasks.filter((t) => !isJob(t) && (t.status === 'open' || (t.status === 'pending review' && !isAdmin())) && mine(t) && taskDueOk(t)).forEach((t) => add(t.store_id));
    if (isAdmin() && state.taskDue === 'any') {
      approvalQueue().forEach((i) => add(i.store_id));
      taskReviewQueue().forEach((l) => { const t = state.tasks.find((x) => x.id === l.task_id); if (t && !isJob(t)) add(t.store_id); });
    }
  }
  const stores = state.stores.filter((st) => count.has(st.id))
    .sort((a, b) => acctRank(a.account) - acctRank(b.account) || storeNum(a) - storeNum(b));
  sel.innerHTML = '<option value="all">All stores</option>'
    + stores.map((st) => `<option value="${esc(st.id)}">${esc(st.name)} · ${esc(city(st))} (${count.get(st.id)})</option>`).join('')
    + (count.has('') ? `<option value="none">Not tied to a store (${count.get('')})</option>` : '');
  if (![...sel.options].some((o) => o.value === state.taskStore)) state.taskStore = 'all';
  sel.value = state.taskStore;
  sel.hidden = stores.length + (count.has('') ? 1 : 0) < 2;
  $('taskDueChips').hidden = state.taskFilter === 'done';
  sel.closest('.task-bar').hidden = sel.hidden && state.taskFilter === 'done';
}

function renderTasks() {
  renderTaskStoreFilter();
  $('taskAllChip').hidden = !canSeeUsers();
  $('newTaskBtn').hidden = !isAdmin();
  if (!canSeeUsers() && state.taskFilter === 'all') state.taskFilter = 'mine';
  document.querySelectorAll('#taskChips .chip, #taskDueChips .chip').forEach((c) => c.classList.toggle('active',
    c.dataset.due ? c.dataset.due === state.taskDue : c.dataset.val === state.taskFilter));
  // Counts on Due today / Overdue for the current Mine/Everyone + store pick.
  const openPool = state.tasks.filter((t) => !isJob(t) && t.status === 'open' && taskStoreOk(t.store_id)
    && (state.taskFilter !== 'mine' || t.assignee_id === state.me?.id));
  for (const [id, cls] of [['taskTodayChip', 'today'], ['taskLateChip', 'overdue']]) {
    const n = openPool.filter((t) => dueInfo(t).cls === cls).length;
    $(id).querySelector('.n').textContent = n || '';
    $(id).classList.toggle('attention', cls === 'overdue' && n > 0 && state.taskDue !== 'overdue');
  }
  const list = $('taskList');
  let rows;
  const logStoreOk = (l) => { const t = state.tasks.find((x) => x.id === l.task_id); return !!t && !isJob(t) && taskStoreOk(t.store_id); };
  if (state.taskFilter === 'done') rows = state.taskLog.length ? state.taskLog.filter(logStoreOk)
    : state.tasks.filter((t) => !isJob(t) && taskStoreOk(t.store_id) && t.status === 'done' && (canSeeUsers() || t.assignee_id === state.me?.id))
      .sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
  else rows = state.tasks.filter((t) => !isJob(t) && taskStoreOk(t.store_id) && (t.status === 'open' || (t.status === 'pending review' && !isAdmin())) && (state.taskFilter === 'all' || t.assignee_id === state.me?.id) && taskDueOk(t))
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  const overdue = rows.filter((t) => t.status === 'open' && dueInfo(t).cls === 'overdue').length;
  const approvals = state.taskFilter !== 'done' && state.taskDue === 'any' && isAdmin() ? approvalQueue().filter((i) => taskStoreOk(i.store_id)) : [];
  const reviews = state.taskFilter !== 'done' && state.taskDue === 'any' && isAdmin() ? taskReviewQueue().filter(logStoreOk) : [];
  const toApprove = approvals.length + reviews.length;
  $('tasksSub').textContent = state.taskFilter === 'done' ? `${rows.length} finished`
    : `${toApprove ? `${toApprove} to approve · ` : ''}${rows.length} open${overdue ? ` · ${overdue} overdue` : ''}`;
  const approvalHTML = toApprove
    ? `<div class="task-group warn">Needs your approval</div>${reviews.map(reviewCardHTML).join('')}${approvals.map((i) => issueCardHTML(i)).join('')}` : '';
  if (!rows.length) {
    list.innerHTML = approvalHTML + (toApprove && state.taskFilter !== 'done'
      ? '<div class="task-group">Follow-ups</div><p class="task-empty">No open follow-ups.</p>'
      : emptyHTML(state.taskFilter === 'done' ? 'Nothing finished yet' : state.taskDue === 'today' ? 'Nothing due today' : state.taskDue === 'overdue' ? 'Nothing overdue' : 'No follow-ups', state.taskFilter === 'mine' ? 'Tasks assigned to you show up here.' : ''));
    return;
  }
  if (state.taskFilter === 'done') { list.innerHTML = state.taskLog.length ? doneLogHTML(rows) : rows.map(taskCardHTML).join(''); return; }
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
function doneLogHTML(logs = state.taskLog) {
  const latest = new Map();
  state.taskLog.forEach((l) => { if (!latest.has(l.task_id)) latest.set(l.task_id, l.id); });
  return logs.map((l) => {
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
  $('taskTitleLabel').textContent = taskIsJob ? 'Job (area or work to do)' : 'What needs to happen';
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
// The calendar is information only: every job shows on its date(s); nobody checks them off here.
// kind: past | today | upcoming
function calItems(from, to) {
  const out = [];
  const now = today();
  const kindOf = (d) => (d < now ? 'past' : d === now ? 'today' : 'upcoming');
  for (const t of state.tasks) {
    if (!t.due_date || !isJob(t) || !calVisible(t)) continue;
    let d = t.due_date, guard = 0;
    while (d && d <= to && guard++ < 400) {
      if (d >= from) out.push({ date: d, t, kind: kindOf(d) });
      if (t.repeat === 'none') break;
      d = nextOccurrence(t, d);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || storeNum(state.byId.get(a.t.store_id) || {}) - storeNum(state.byId.get(b.t.store_id) || {}) || a.t.title.localeCompare(b.t.title));
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
  $('calSub').textContent = `${inMonth.length} job${inMonth.length === 1 ? '' : 's'} ${state.calView === 'week' ? 'this week' : 'this month'}`;

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
    const max = oneStore ? 6 : 2;
    const labels = list.slice(0, max).map((it) => `<span class="cal-lbl k-${it.kind}">${esc(it.t.title)}</span>`).join('');
    const more = list.length > max ? `<span class="cal-more">+${list.length - max}</span>` : '';
    const count = list.length ? `<span class="cal-count">${list.length}</span>` : '';
    cells += `<button class="cal-cell${other ? ' other' : ''}${d === today() ? ' today' : ''}${d === day ? ' sel' : ''}" data-act="calday" data-id="${d}"
      aria-label="${esc(fmtDate(d))}: ${list.length ? `${list.length} job${list.length === 1 ? '' : 's'}` : 'nothing'}">
      <span class="cal-num">${Number(d.slice(8))}</span>${count}<span class="cal-lbls">${labels}${more}</span></button>`;
  }
  $('calGrid').innerHTML = head + cells;
  $('calAgenda').innerHTML = calDayHTML(day, byDate.get(day) || []);
}

function calDayHTML(d, list, { compactEmpty = false } = {}) {
  const label = new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const add = isAdmin() ? `<button class="btn btn-sm icon" data-act="calnew" data-id="${d}" aria-label="Add a job on ${esc(label)}"><i class="ti ti-plus" aria-hidden="true"></i></button>` : '';
  const head = `<div class="cal-day-head${d === today() ? ' today' : ''}"><span>${esc(label)}${d === today() ? ' · Today' : ''}</span>${add}</div>`;
  if (!list.length) return head + (compactEmpty ? '' : '<p class="task-empty">Nothing scheduled.</p>');
  return head + list.map(calItemHTML).join('');
}

function calItemHTML(it, { hideStore = false } = {}) {
  const { t, kind } = it;
  const s = state.byId.get(t.store_id);
  const meta = [
    s && !hideStore ? `${esc(s.name)} ${esc(city(s))}` : '',
    t.assignee_name ? esc(t.assignee_name) : ''
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('<span>·</span>');
  const edit = isAdmin() ? ` data-act="taskedit" data-id="${t.id}" role="button" tabindex="0" aria-label="Edit ${esc(t.title)}"` : '';
  return `<article class="cal-item k-${kind}${isAdmin() ? ' editable' : ''}"${edit}>
    <div class="cal-item-main">
      <div class="task-title">${esc(t.title)}</div>
      ${meta || (t.repeat && t.repeat !== 'none') ? `<div class="task-meta">${meta}${t.repeat && t.repeat !== 'none' ? `<span class="tag repeat"><i class="ti ti-repeat" aria-hidden="true"></i> ${esc(repeatText(t))}</span>` : ''}</div>` : ''}
    </div>
    ${isAdmin() ? `<div class="task-actions"><button class="btn btn-sm icon" data-act="taskedit" data-id="${t.id}" aria-label="Edit job"><i class="ti ti-pencil" aria-hidden="true"></i></button></div>` : ''}
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

// Day view (the default): the day's jobs, grouped by store.
function renderCalendarDay(day) {
  const now = today();
  const label = new Date(day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const near = day === now ? 'Today' : day === addDays(now, 1) ? 'Tomorrow' : day === addDays(now, -1) ? 'Yesterday' : '';
  $('calTitle').textContent = near || label.split(',')[0];
  const list = calItems(day, day);
  const stores = new Set(list.map((it) => it.t.store_id)).size;
  $('calSub').textContent = `${near ? label : label.split(', ')[1]} · ${list.length} job${list.length === 1 ? '' : 's'}${stores > 1 ? ` in ${stores} stores` : ''}`;
  $('calGrid').innerHTML = '';
  $('calGrid').hidden = true;
  const add = isAdmin() ? `<button class="btn btn-sm icon" data-act="calnew" data-id="${day}" aria-label="Add a job on ${esc(label)}"><i class="ti ti-plus" aria-hidden="true"></i></button>` : '';
  if (!list.length) {
    $('calAgenda').innerHTML = `<div class="cal-day-head"><span></span>${add}</div><p class="task-empty">No floor care jobs ${day === now ? 'today' : 'this day'}.</p>`;
    return;
  }
  const groups = new Map();
  list.forEach((it) => { const k = it.t.store_id || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); });
  const keys = [...groups.keys()].sort((a, b) => {
    const sa = state.byId.get(a), sb = state.byId.get(b);
    return (sa ? acctRank(sa.account) : 99) - (sb ? acctRank(sb.account) : 99) || (sa ? storeNum(sa) : 0) - (sb ? storeNum(sb) : 0);
  });
  $('calAgenda').innerHTML = keys.map((k, n) => {
    const s = state.byId.get(k);
    const g = groups.get(k);
    return `<div class="cal-store-head"><span><b>${esc(s ? s.name : 'No store')}</b>${s ? ` · ${esc(city(s))}` : ''}</span><span class="cal-store-count">${g.length} job${g.length === 1 ? '' : 's'}</span>${n === 0 ? add : ''}</div>`
      + g.map((it) => calItemHTML(it, { hideStore: true })).join('');
  }).join('');
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
    // Store hours notes start unchecked.
    if (day && title) out.push({ date, title: tidyTitle(title), keep: !/^store (opens|closes|closed|open)\b/i.test(title) });
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
  return s.toLowerCase().replace(/(^|[\s/&(-])([a-z])/g, (_, p, c) => p + c.toUpperCase())
    .replace(/ (In|Of|And|The|To|At|On|For) /g, (w) => w.toLowerCase())
    .replace(/\b(Gm|Hbc|Cac|Mgr)\b/g, (w) => (w === 'Mgr' ? w : w.toUpperCase()));
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

// ── AUDITS ────────────────────────────────────────────────────────────
// Supervisors audit their stores on their phone: a checklist (pass/fail, 1–5 ratings, notes),
// photos, and a location check so it can only be filled in at the store. Admins get a PDF.
// To change the questions, edit this list. Each audit keeps a copy of the list it was done with.
const AUDIT_CHECKLIST = {
  version: 1,
  sections: [
    { id: 'entrance', title: 'Entrance & vestibule', questions: [
      { id: 'ent_clean', type: 'pf', text: 'Floor clean, no dirt, debris or salt residue' },
      { id: 'ent_mats', type: 'pf', text: 'Mats clean, flat and in place' },
      { id: 'ent_shine', type: 'rate', text: 'Floor shine / appearance' }
    ] },
    { id: 'floor', title: 'Sales floor', questions: [
      { id: 'fl_buildup', type: 'pf', text: 'No buildup along edges, corners and under fixtures' },
      { id: 'fl_marks', type: 'pf', text: 'No black marks, scuffs or sticky spots' },
      { id: 'fl_cove', type: 'pf', text: 'Baseboards and cove base clean' },
      { id: 'fl_shine', type: 'rate', text: 'Overall floor shine / gloss' }
    ] },
    { id: 'coolers', title: 'Coolers & freezers', questions: [
      { id: 'co_floor', type: 'pf', text: 'Floors clean, no ice or food buildup' },
      { id: 'co_drains', type: 'pf', text: 'Drains clean, flowing, no odor' },
      { id: 'co_cal', type: 'pf', text: "This month's calendar areas done", help: 'Check the store\'s floor care calendar on the Calendar tab' },
      { id: 'co_rate', type: 'rate', text: 'Overall cooler & freezer condition' }
    ] },
    { id: 'back', title: 'Backroom & receiving', questions: [
      { id: 'bk_floor', type: 'pf', text: 'Floors swept and scrubbed' },
      { id: 'bk_water', type: 'pf', text: 'No standing water' },
      { id: 'bk_rate', type: 'rate', text: 'Overall backroom condition' }
    ] },
    { id: 'equip', title: 'Equipment & chemicals', questions: [
      { id: 'eq_clean', type: 'pf', text: 'Equipment clean, stored in its place, charged' },
      { id: 'eq_work', type: 'pf', text: 'Equipment working (pads, squeegees, batteries)' },
      { id: 'eq_chem', type: 'pf', text: 'Chemicals labeled, closed, SDS available' }
    ] },
    { id: 'safety', title: 'Safety', questions: [
      { id: 'sf_signs', type: 'pf', text: 'Wet floor signs used, and picked up after' },
      { id: 'sf_slip', type: 'pf', text: 'No slip hazards found' },
      { id: 'sf_ppe', type: 'pf', text: 'Crew in uniform / PPE' }
    ] },
    { id: 'store', title: 'Store feedback', questions: [
      { id: 'st_talk', type: 'pf', text: 'Spoke with a store manager', yes: 'Yes', no: 'No' },
      { id: 'st_who', type: 'text', text: 'Manager name', optional: true },
      { id: 'st_fb', type: 'text', text: 'What the store said', optional: true },
      { id: 'st_notes', type: 'text', text: 'Your notes and follow-ups', optional: true }
    ] }
  ]
};
const AUDIT_FENCE_M = 1609; // 1 mile
const auditBadge = (sc, extra = '') => (sc == null
  ? `<span class="score none ${extra}" style="--v:0"><span><i class="ti ti-pencil" aria-hidden="true"></i></span></span>`
  : `<span class="score ${band(sc)} ${extra}" style="--v:${sc}"><span>${sc}</span></span>`);
const auditQs = (cl) => cl.sections.flatMap((s) => s.questions);

// Pass = 1, fail = 0, rating 1–5 → 0–1. N/A and text don't count.
function auditScore(cl, answers, sectionId = null) {
  let sum = 0, n = 0;
  for (const s of cl.sections) {
    if (sectionId && s.id !== sectionId) continue;
    for (const q of s.questions) {
      const v = answers[q.id]?.v;
      if (q.type === 'pf' && (v === 'pass' || v === 'fail')) { sum += v === 'pass' ? 1 : 0; n++; }
      if (q.type === 'rate' && Number(v) >= 1) { sum += (Number(v) - 1) / 4; n++; }
    }
  }
  return n ? Math.round((sum / n) * 100) : null;
}

// What still has to be filled in before submitting.
function auditMissing(cl, answers) {
  const out = [];
  for (const q of auditQs(cl)) {
    const a = answers[q.id] || {};
    if (q.type !== 'text' && !a.v) out.push({ q, why: 'Not answered' });
    else if (q.type === 'pf' && a.v === 'fail' && !q.yes) {
      if (!(a.note || '').trim()) out.push({ q, why: 'Failed: add a note' });
      if (!(a.photos || []).length) out.push({ q, why: 'Failed: add a photo' });
    }
  }
  return out;
}

const canAudit = () => ['admin', 'supervisor'].includes(state.me?.role);

// ── Location ──
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This phone or browser can\'t share its location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Location is blocked for CSMD. Allow location in your phone\'s settings, then try again.' : 'Couldn\'t get your location. Step near the entrance or a window and try again.')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}
function metersBetween(a, b) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
// Turn the database's coded messages into plain ones.
const auditError = (e) => String(e?.message || e).replace(/^(NO_STORE_LOCATION|NO_GPS|WEAK_GPS|TOO_FAR):\s*/, '');

// ── A store's audits (on the store page) ──
const canAuditStore = (sid) => isAdmin() || (state.me?.role === 'supervisor' && state.assignments.some((x) => x.user_id === state.me.id && x.store_id === sid));

function storeAuditsHTML(s) {
  const rows = state.audits.filter((a) => a.store_id === s.id && (a.status === 'submitted' || a.auditor_id === state.me?.id));
  const card = (a) => {
    const when = a.submitted_at || a.started_at;
    const sc = a.status === 'submitted' ? Math.round(a.score) : null;
    return `<button class="audit-card" data-act="auditopen" data-id="${a.id}">
      ${auditBadge(sc)}
      <span class="audit-card-main"><b>${a.status === 'draft' ? 'Not finished' : `Score ${sc}`}</b>
        <span class="audit-card-meta">${esc(fmtDate(isoLocal(new Date(when))))} · ${esc(a.auditor_name || '')}</span></span>
      <i class="ti ti-chevron-right" aria-hidden="true"></i></button>`;
  };
  const drafts = rows.filter((a) => a.status === 'draft'), done = rows.filter((a) => a.status === 'submitted');
  return [...drafts, ...done].map(card).join('') || '<p class="task-empty">No audits yet.</p>';
}

function backToStore() {
  if (audit?.store_id) state.selectedId = audit.store_id;
  switchScreen(state.selectedId ? 'detail' : 'stores');
}

async function loadAudits() {
  try { state.audits = await db.getAudits(); } catch { state.audits = []; }
}

// ── Start ──
function openAuditStart(sid) {
  const s = state.byId.get(sid);
  if (!s) return;
  $('auditStartStore').textContent = `${s.name} · ${city(s)}`;
  $('auditStartStore').dataset.id = sid;
  $('auditStartError').hidden = true;
  $('auditStartGo').disabled = false;
  $('auditStartGo').textContent = 'Check location & start';
  // Pick up where they left off instead of starting a second one.
  const draft = state.audits.find((a) => a.store_id === sid && a.status === 'draft' && a.auditor_id === state.me?.id);
  if (draft) { openAudit(draft.id); showToast('You already have an unfinished audit here. Picking up where you left off.'); return; }
  openSheet('auditStartSheet');
}

async function startAudit() {
  const err = $('auditStartError');
  const fail = (m) => { err.textContent = m; err.hidden = false; $('auditStartGo').disabled = false; $('auditStartGo').textContent = 'Check location & start'; };
  const sid = $('auditStartStore').dataset.id;
  const s = state.byId.get(sid);
  if (s?.lat == null) return fail(`${s?.name || 'This store'}'s location isn't set yet. ${isAdmin() ? 'Tap "Set store locations" on the Stores page.' : 'Ask Murod to set it.'}`);
  $('auditStartGo').disabled = true;
  $('auditStartGo').textContent = 'Checking location…';
  err.hidden = true;
  try {
    const pos = await getPosition();
    const d = metersBetween(pos, { lat: s.lat, lng: s.lng });
    if (pos.acc > 300) return fail(`Your phone's location isn't exact enough (± ${Math.round(pos.acc)} m). Step near the entrance or a window and try again.`);
    if (d > AUDIT_FENCE_M + Math.min(pos.acc, 50)) return fail(`You're ${(d / 1609.34).toFixed(2)} miles from ${s.name}. Audits can only be done at the store (within 1 mile).`);
    const id = await db.startAudit(sid, AUDIT_CHECKLIST, pos);
    closeSheet('auditStartSheet');
    await loadAudits();
    await openAudit(Number(id));
  } catch (e) { fail(auditError(e)); }
}

// ── Fill in / view ──
let audit = null;        // the open audit (full row)
let auditUrls = new Map(); // photo path → signed url
let auditSaveTimer = null;

async function openAudit(id) {
  try { audit = await db.getAudit(id); } catch (e) { showToast(friendlyDbError(e), { error: true }); return; }
  $('auditBackLabel').textContent = state.byId.get(audit.store_id)?.name || 'Store';
  const paths = [...auditQs(audit.checklist).flatMap((q) => audit.answers[q.id]?.photos || []), ...(audit.photos || [])];
  await refreshPhotoUrls(paths);
  switchScreen('audit');
}

async function refreshPhotoUrls(paths) {
  const need = paths.filter((p) => !auditUrls.has(p));
  if (!need.length) return;
  try { (await db.photoUrls(need)).forEach((r) => { if (r.signedUrl) auditUrls.set(r.path, r.signedUrl); }); } catch { /* shown as missing */ }
}

const auditEditable = () => audit && audit.status === 'draft' && audit.auditor_id === state.me?.id;

function renderAuditForm() {
  if (!audit) { switchScreen('stores'); return; }
  const s = state.byId.get(audit.store_id);
  const edit = auditEditable();
  const cl = audit.checklist;
  const ans = audit.answers || {};
  $('auditTitle').textContent = s ? s.name : audit.store_id;
  const when = new Date(audit.submitted_at || audit.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('auditSub').textContent = `${city(s)} · ${audit.auditor_name || ''} · ${when}`;
  const total = auditQs(cl).filter((q) => q.type !== 'text').length;
  const answered = auditQs(cl).filter((q) => q.type !== 'text' && ans[q.id]?.v).length;
  const sc = audit.status === 'submitted' ? Math.round(audit.score) : auditScore(cl, ans);
  $('auditBar').innerHTML = `
    ${auditBadge(sc)}
    <span class="audit-bar-text"><b>${audit.status === 'submitted' ? 'Score' : 'Score so far'}</b>
      <span>${audit.status === 'submitted' ? `Submitted · at the store (${Math.round(audit.submit_distance_m ?? 0)} m)` : `${answered} of ${total} answered`}</span></span>
    ${audit.status === 'submitted' ? `<button class="btn btn-primary btn-sm" data-act="auditpdf"><i class="ti ti-file-type-pdf" aria-hidden="true"></i>PDF</button>` : ''}`;

  const photoStrip = (paths, qid) => `<div class="audit-photos">${(paths || []).map((p) => `
      <span class="audit-photo">${auditUrls.get(p) ? `<img src="${esc(auditUrls.get(p))}" alt="Audit photo" loading="lazy" data-act="auditphotoview" data-id="${esc(p)}">` : '<i class="ti ti-photo-off" aria-hidden="true"></i>'}
        ${edit ? `<button class="audit-photo-x" data-act="auditphotodel" data-id="${esc(qid)}|${esc(p)}" aria-label="Remove photo"><i class="ti ti-x" aria-hidden="true"></i></button>` : ''}</span>`).join('')}
      ${edit ? `<label class="btn btn-sm audit-add-photo"><i class="ti ti-camera" aria-hidden="true"></i>Photo<input type="file" accept="image/*" capture="environment" multiple hidden data-photo="${esc(qid)}"></label>` : ''}</div>`;

  let html = '';
  for (const sec of cl.sections) {
    const ss = auditScore(cl, ans, sec.id);
    html += `<section class="audit-sec"><div class="audit-sec-head"><h2>${esc(sec.title)}</h2>${ss == null ? '' : auditBadge(ss, 'sm')}</div>`;
    for (const q of sec.questions) {
      const a = ans[q.id] || {};
      const failed = q.type === 'pf' && a.v === 'fail' && !q.yes;
      html += `<div class="audit-q${failed ? ' failed' : ''}" id="aq-${esc(q.id)}"><div class="audit-q-text">${esc(q.text)}${q.help ? `<span class="audit-q-help">${esc(q.help)}</span>` : ''}</div>`;
      if (q.type === 'pf') {
        const opts = [['pass', q.yes || 'Pass'], ['fail', q.no || 'Fail'], ['na', 'N/A']];
        html += `<div class="seg" role="radiogroup" aria-label="${esc(q.text)}">${opts.map(([v, l]) => `<button class="seg-btn v-${v}${a.v === v ? ' on' : ''}" ${edit ? `data-act="auditans" data-id="${esc(q.id)}|${v}"` : 'disabled'} role="radio" aria-checked="${a.v === v}">${esc(l)}</button>`).join('')}</div>`;
      } else if (q.type === 'rate') {
        html += `<div class="seg rate" role="radiogroup" aria-label="${esc(q.text)}, 1 poor to 5 excellent">${[1, 2, 3, 4, 5].map((n) => `<button class="seg-btn${Number(a.v) === n ? ' on' : ''}" ${edit ? `data-act="auditans" data-id="${esc(q.id)}|${n}"` : 'disabled'} role="radio" aria-checked="${Number(a.v) === n}">${n}</button>`).join('')}</div>
          <div class="seg-legend"><span>Poor</span><span>Excellent</span></div>`;
      }
      if (q.type === 'text') {
        html += edit ? `<textarea rows="2" data-note="${esc(q.id)}" data-field="v" placeholder="${q.optional ? 'Optional' : ''}">${esc(a.v || '')}</textarea>` : `<p class="audit-text">${esc(a.v || '—')}</p>`;
      } else if (edit) {
        html += `<textarea rows="${failed ? 2 : 1}" data-note="${esc(q.id)}" data-field="note" placeholder="${failed ? 'What\'s wrong? (needed)' : 'Note (optional)'}">${esc(a.note || '')}</textarea>`;
      } else if (a.note) html += `<p class="audit-text">${esc(a.note)}</p>`;
      if (q.type !== 'text' && (edit || (a.photos || []).length)) html += photoStrip(a.photos, q.id);
      html += '</div>';
    }
    html += '</section>';
  }
  html += `<section class="audit-sec"><div class="audit-sec-head"><h2>More photos</h2></div>
    ${edit || (audit.photos || []).length ? photoStrip(audit.photos, '_general') : '<p class="audit-text">None</p>'}</section>`;
  if (edit) {
    html += `<p class="field-error" id="auditError" hidden></p>
      <div class="audit-actions">
        <button class="btn btn-ghost" data-act="auditdelete">Delete draft</button>
        <button class="btn btn-primary" data-act="auditsubmit"><i class="ti ti-map-pin-check" aria-hidden="true"></i>Submit audit</button>
      </div>
      <p class="page-sub audit-fine">Submitting checks your location again. Your answers save as you go, so you can come back to this.</p>`;
  } else if (isAdmin()) {
    html += `<div class="audit-actions"><button class="btn btn-ghost" data-act="auditdelete">Delete audit</button></div>`;
  }
  $('auditForm').innerHTML = html;
}

function auditSaveSoon() {
  clearTimeout(auditSaveTimer);
  auditSaveTimer = setTimeout(auditSaveNow, 700);
}
async function auditSaveNow() {
  clearTimeout(auditSaveTimer);
  if (!auditEditable()) return;
  try { await db.saveAudit(audit.id, { answers: audit.answers, photos: audit.photos }); $('auditSaved').textContent = 'Saved'; }
  catch (e) { $('auditSaved').textContent = 'Not saved, check connection'; showToast(friendlyDbError(e), { error: true }); }
}

function auditAnswer(qid, v) {
  const a = audit.answers[qid] || (audit.answers[qid] = {});
  a.v = a.v === v ? null : v; // tap again to clear
  auditSaveSoon();
  const y = window.scrollY;
  renderAuditForm();
  window.scrollTo({ top: y });
}

function onAuditInput(e) {
  const t = e.target;
  if (t.dataset.note) {
    const a = audit.answers[t.dataset.note] || (audit.answers[t.dataset.note] = {});
    a[t.dataset.field] = t.value;
    $('auditSaved').textContent = 'Saving…';
    auditSaveSoon();
  }
}

// Shrink to at most 1600 px so uploads are quick on a phone connection.
async function shrinkPhoto(file) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That file isn\'t a photo.'));
    i.src = URL.createObjectURL(file);
  });
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.72));
}

async function onAuditPhotos(e) {
  const input = e.target;
  if (!input.dataset.photo || !input.files?.length) return;
  const qid = input.dataset.photo;
  const files = [...input.files];
  $('auditSaved').textContent = `Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`;
  for (const f of files) {
    try {
      const blob = await shrinkPhoto(f);
      const path = `${audit.id}/${qid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
      await db.uploadAuditPhoto(path, blob);
      auditUrls.set(path, URL.createObjectURL(blob));
      if (qid === '_general') audit.photos = [...(audit.photos || []), path];
      else { const a = audit.answers[qid] || (audit.answers[qid] = {}); a.photos = [...(a.photos || []), path]; }
    } catch (err) { showToast(`Photo not added: ${friendlyDbError(err)}`, { error: true }); }
  }
  await auditSaveNow();
  const y = window.scrollY;
  renderAuditForm();
  window.scrollTo({ top: y });
}

async function auditPhotoDelete(key) {
  const [qid, path] = key.split('|');
  if (qid === '_general') audit.photos = (audit.photos || []).filter((p) => p !== path);
  else if (audit.answers[qid]) audit.answers[qid].photos = (audit.answers[qid].photos || []).filter((p) => p !== path);
  await auditSaveNow();
  db.removeAuditPhoto(path).catch(() => {});
  const y = window.scrollY;
  renderAuditForm();
  window.scrollTo({ top: y });
}

async function submitAudit() {
  const err = $('auditError');
  const fail = (m) => { err.textContent = m; err.hidden = false; btn.disabled = false; btn.innerHTML = '<i class="ti ti-map-pin-check" aria-hidden="true"></i>Submit audit'; };
  const btn = document.querySelector('[data-act="auditsubmit"]');
  const missing = auditMissing(audit.checklist, audit.answers);
  if (missing.length) {
    fail(`${missing.length} thing${missing.length === 1 ? '' : 's'} left: ${missing.slice(0, 3).map((m) => `"${m.q.text}" (${m.why.toLowerCase()})`).join(', ')}${missing.length > 3 ? '…' : ''}`);
    document.getElementById(`aq-${missing[0].q.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  btn.disabled = true; btn.textContent = 'Checking location…';
  try {
    await auditSaveNow();
    const pos = await getPosition();
    await db.submitAudit(audit.id, auditScore(audit.checklist, audit.answers) ?? 0, pos);
    audit = await db.getAudit(audit.id);
    await loadAudits();
    renderAuditForm();
    window.scrollTo({ top: 0 });
    showToast(`Audit submitted · score ${Math.round(audit.score)}`);
  } catch (e) { fail(auditError(e)); }
}

async function deleteAudit() {
  const draft = audit.status === 'draft';
  if (!confirm(draft ? 'Delete this unfinished audit and its photos?' : 'Delete this audit and its photos? This can\'t be undone.')) return;
  const paths = [...auditQs(audit.checklist).flatMap((q) => audit.answers[q.id]?.photos || []), ...(audit.photos || [])];
  try {
    await db.deleteAudit(audit.id, paths);
    const sid = audit.store_id;
    audit = null;
    await loadAudits();
    state.selectedId = sid;
    switchScreen('detail');
    showToast('Audit deleted');
  } catch (e) { showToast(friendlyDbError(e), { error: true }); }
}

// ── PDF ──
let jsPdfLoading = null;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  jsPdfLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
    s.onload = () => resolve(window.jspdf.jsPDF);
    s.onerror = () => { jsPdfLoading = null; reject(new Error('Couldn\'t load the PDF maker. Check your connection.')); };
    document.head.appendChild(s);
  });
  return jsPdfLoading;
}

async function photoData(path) {
  const url = auditUrls.get(path);
  if (!url) return null;
  const blob = await (await fetch(url)).blob();
  const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  const dims = await new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r([4, 3]); i.src = data; });
  return { data, w: dims[0], h: dims[1] };
}

async function auditPdf() {
  const btn = document.querySelector('[data-act="auditpdf"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Making PDF…'; }
  try {
    const JsPDF = await loadJsPdf();
    const a = audit, cl = a.checklist, ans = a.answers || {};
    const s = state.byId.get(a.store_id);
    const allPaths = [...auditQs(cl).flatMap((q) => ans[q.id]?.photos || []), ...(a.photos || [])];
    await refreshPhotoUrls(allPaths);
    const doc = new JsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
    let y = M;
    const need = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
    const text = (t, x, size = 10, style = 'normal', color = [20, 20, 20], width = W - M - x) => {
      doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color);
      const lines = doc.splitTextToSize(String(t), width);
      lines.forEach((ln) => { need(size * 1.3); doc.text(ln, x, y + size); y += size * 1.3; });
    };
    const scoreColor = (n) => (n >= 85 ? [30, 120, 60] : n >= 70 ? [180, 120, 0] : [190, 40, 40]);
    const when = new Date(a.submitted_at || a.started_at);

    // Header
    text('Floor Care Audit', M, 20, 'bold');
    text(`${s?.name || a.store_id} · ${city(s)}`, M, 13, 'normal', [60, 60, 60]);
    y += 4;
    text(`Date: ${when.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`, M, 10, 'normal', [90, 90, 90]);
    text(`Auditor: ${a.auditor_name || ''}`, M, 10, 'normal', [90, 90, 90]);
    text(a.status === 'submitted' ? `Location checked: at the store (${Math.round(a.submit_distance_m ?? 0)} m from store pin)` : 'Not submitted yet', M, 10, 'normal', [90, 90, 90]);
    const total = Math.round(a.score ?? auditScore(cl, ans) ?? 0);
    doc.setFillColor(...scoreColor(total)); doc.roundedRect(W - M - 90, M, 90, 56, 6, 6, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.text(String(total), W - M - 45, M + 32, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text('SCORE', W - M - 45, M + 47, { align: 'center' });
    y = Math.max(y, M + 64) + 8;

    // Section summary
    doc.setDrawColor(220, 220, 220); doc.line(M, y, W - M, y); y += 10;
    text('Summary', M, 12, 'bold');
    for (const sec of cl.sections) {
      const ss = auditScore(cl, ans, sec.id);
      if (ss == null) continue;
      need(16);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(20, 20, 20); doc.text(sec.title, M, y + 10);
      doc.setFillColor(235, 235, 235); doc.rect(M + 170, y + 3, 260, 8, 'F');
      doc.setFillColor(...scoreColor(ss)); doc.rect(M + 170, y + 3, 260 * ss / 100, 8, 'F');
      doc.setTextColor(...scoreColor(ss)); doc.setFont('helvetica', 'bold'); doc.text(String(ss), M + 440, y + 10);
      y += 16;
    }
    const fails = auditQs(cl).filter((q) => q.type === 'pf' && !q.yes && ans[q.id]?.v === 'fail');
    if (fails.length) {
      y += 6;
      text(`Needs attention (${fails.length})`, M, 12, 'bold', [190, 40, 40]);
      fails.forEach((q) => text(`• ${q.text}${ans[q.id]?.note ? ` — ${ans[q.id].note}` : ''}`, M + 6, 10));
    }

    // Each section in full
    const label = (q, v) => (q.type === 'pf' ? ({ pass: q.yes || 'Pass', fail: q.no || 'Fail', na: 'N/A' }[v] || '—') : q.type === 'rate' ? (v ? `${v} / 5` : '—') : '');
    const vColor = (q, v) => (q.type === 'pf' ? (v === 'pass' ? [30, 120, 60] : v === 'fail' && !q.yes ? [190, 40, 40] : [90, 90, 90]) : q.type === 'rate' ? scoreColor(((Number(v) || 1) - 1) * 25) : [20, 20, 20]);
    for (const sec of cl.sections) {
      y += 10; need(40);
      doc.setDrawColor(220, 220, 220); doc.line(M, y, W - M, y); y += 8;
      text(sec.title, M, 13, 'bold');
      for (const q of sec.questions) {
        const v = ans[q.id]?.v;
        need(18);
        if (q.type === 'text') {
          text(q.text, M, 10, 'bold', [60, 60, 60]);
          text(v || '—', M + 10, 10);
        } else {
          const top = y;
          text(q.text, M, 10, 'normal', [20, 20, 20], W - 2 * M - 70);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...vColor(q, v));
          doc.text(label(q, v), W - M, top + 10, { align: 'right' });
          if (ans[q.id]?.note) text(`Note: ${ans[q.id].note}`, M + 10, 9, 'italic', [90, 90, 90]);
        }
        await pdfPhotos(doc, ans[q.id]?.photos || []);
        y += 4;
      }
    }
    if ((a.photos || []).length) {
      y += 10; need(240);
      doc.setDrawColor(220, 220, 220); doc.line(M, y, W - M, y); y += 8;
      text('More photos', M, 13, 'bold');
      await pdfPhotos(doc, a.photos);
    }
    // Page numbers
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140, 140, 140);
      doc.text(`CSMD · ${s?.name || a.store_id} audit · ${when.toLocaleDateString('en-US')} · page ${i} of ${n}`, W / 2, H - 20, { align: 'center' });
    }
    const file = `Audit ${s?.name || a.store_id} ${isoLocal(when)}.pdf`.replace(/[#/\\]/g, '');
    const blob = doc.output('blob');
    const f = new File([blob], file, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: file }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = file; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    // Two photos per row, kept in proportion.
    async function pdfPhotos(d, paths) {
      if (!paths.length) return;
      const colW = (W - 2 * M - 12) / 2, maxH = 190;
      for (let i = 0; i < paths.length; i += 2) {
        const pair = (await Promise.all(paths.slice(i, i + 2).map((p) => photoData(p).catch(() => null)))).filter(Boolean);
        if (!pair.length) continue;
        const sizes = pair.map((p) => { const k = Math.min(colW / p.w, maxH / p.h); return [p.w * k, p.h * k]; });
        const rowH = Math.max(...sizes.map((z) => z[1]));
        need(rowH + 6); y += 4;
        pair.forEach((p, k) => d.addImage(p.data, 'JPEG', M + k * (colW + 12), y, sizes[k][0], sizes[k][1]));
        y += rowH + 4;
      }
    }
  } catch (e) { showToast(friendlyDbError(e), { error: true }); }
  finally { const b = document.querySelector('[data-act="auditpdf"]'); if (b) { b.disabled = false; b.innerHTML = '<i class="ti ti-file-type-pdf" aria-hidden="true"></i>PDF'; } }
}

// ── Store location (admins) ──
// Address → map point, using OpenStreetMap (free; one lookup per second).
async function geocode(q, mustContain = null) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=us&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Map search is busy. Try again in a minute.');
  const hits = await r.json();
  return mustContain ? hits.filter((h) => new RegExp(mustContain.split(' ')[0], 'i').test(h.display_name)) : hits;
}

// Best map point for a store: the store itself on the map ("Wegmans, Allentown, PA"),
// then its street address. House-number lookups can land a few miles down a long road.
async function storeGeocode(s) {
  const brand = s.account.split(' ')[0];
  const where = city(s);
  if (where) {
    const hits = await geocode(`${brand}, ${where}`, brand);
    const shop = hits.find((h) => /shop|amenity/.test(h.class)) || hits[0];
    if (shop) return { lat: Number(shop.lat), lng: Number(shop.lon), label: shop.display_name };
    await new Promise((r) => setTimeout(r, 1100));
  }
  if (hasStreet(s)) {
    const hits = await geocode(s.address);
    if (hits[0]) return { lat: Number(hits[0].lat), lng: Number(hits[0].lon), label: hits[0].display_name };
  }
  return null;
}

// Pin every active store that has a street address but no location yet.
async function pinAllStores() {
  const todo = state.stores.filter((s) => isActiveStore(s) && hasStreet(s) && s.lat == null);
  const noAddr = state.stores.filter((s) => isActiveStore(s) && !hasStreet(s) && s.lat == null);
  if (!todo.length) {
    showToast(noAddr.length ? `${noAddr.length} store${noAddr.length === 1 ? ' has' : 's have'} no street address yet (${noAddr.slice(0, 3).map((s) => s.name).join(', ')}${noAddr.length > 3 ? '…' : ''}). Use "I'm here" or Paste on the store page.` : 'Every store already has a location.', { duration: 7000 });
    return;
  }
  const btn = $('pinStoresBtn'); btn.disabled = true;
  let ok = 0; const missed = [];
  for (const [k, s] of todo.entries()) {
    btn.textContent = `Pinning ${k + 1} of ${todo.length}…`;
    try {
      const g = await storeGeocode(s);
      if (g) {
        await db.setStoreLocation(s.id, g.lat, g.lng);
        s.lat = g.lat; s.lng = g.lng; ok++;
      } else missed.push(s.name);
    } catch (e) {
      if (/lat|lng|column/i.test(e.message)) { showToast('The database needs the audits update first (migration 013).', { error: true }); break; }
      missed.push(s.name);
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  btn.disabled = false; btn.innerHTML = '<i class="ti ti-map-pin" aria-hidden="true"></i>Set store locations';
  showToast(`${ok} store${ok === 1 ? '' : 's'} pinned${missed.length ? `. Couldn't find: ${missed.join(', ')}. Use "I'm here" or Paste on those store pages.` : '.'}`, { duration: 9000, error: !!missed.length });
}

function storeLocationHTML(s) {
  if (!isAdmin()) return '';
  const set = s.lat != null && s.lng != null;
  return `<div class="store-loc">
    <div><b>Store location</b><span>${set ? `Set · ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)} · audits must be within 1 mile` : 'Not set — needed before anyone can audit this store'}</span></div>
    <div class="store-loc-btns">
      <button class="btn btn-sm" data-act="locfind" data-id="${esc(s.id)}"><i class="ti ti-search" aria-hidden="true"></i>Find</button>
      <button class="btn btn-sm" data-act="lochere" data-id="${esc(s.id)}"><i class="ti ti-current-location" aria-hidden="true"></i>I'm here</button>
      <button class="btn btn-sm" data-act="locpaste" data-id="${esc(s.id)}"><i class="ti ti-clipboard" aria-hidden="true"></i>Paste</button>
    </div></div>`;
}

async function saveStoreLocation(id, lat, lng, how) {
  try {
    await db.setStoreLocation(id, lat, lng);
    const s = state.byId.get(id); s.lat = lat; s.lng = lng;
    renderDetail();
    showToast(`Location saved${how ? ` (${how})` : ''}`);
  } catch (e) { showToast(/lat|lng|column/i.test(e.message) ? 'The database needs the audits update first (migration 013).' : friendlyDbError(e), { error: true }); }
}

async function storeLocHere(id) {
  try {
    const pos = await getPosition();
    if (pos.acc > 100 && !confirm(`Your location is only exact to about ${Math.round(pos.acc)} m. Save it anyway?`)) return;
    await saveStoreLocation(id, pos.lat, pos.lng, 'your current location');
  } catch (e) { showToast(e.message, { error: true }); }
}

async function storeLocFind(id) {
  const s = state.byId.get(id);
  try {
    const g = await storeGeocode(s);
    if (!g) { showToast(`Couldn't find ${s.name} on the map. Use "I'm here" at the store, or paste the location from Google Maps.`, { error: true, duration: 7000 }); return; }
    if (!confirm(`Use this location for ${s.name}?\n\n${g.label}`)) return;
    await saveStoreLocation(id, g.lat, g.lng, 'from the map');
  } catch { showToast('Map search didn\'t work. Try "I\'m here" or Paste.', { error: true }); }
}

async function storeLocPaste(id) {
  const v = prompt('In Google Maps, right-click the store and click the numbers at the top to copy them. Paste them here (like 40.5891, -75.5638):');
  if (!v) return;
  const m = v.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) { showToast('That doesn\'t look like a location. It should be two numbers like 40.5891, -75.5638.', { error: true }); return; }
  await saveStoreLocation(id, Number(m[1]), Number(m[2]), 'pasted');
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
  $('detailSub').textContent = `${hasStreet(s) ? s.address : city(s)} · ${s.account}${isActiveStore(s) ? '' : ' · inactive'}`;
  $('detailScore').className = `score score-ring ${band(score)}`;
  $('detailScore').style.setProperty('--v', score);
  $('detailScore').innerHTML = `<span>${score}</span>`;
  $('detailScore').setAttribute('aria-label', `Health score ${score} out of 100`);

  const btn = $('detailActiveBtn');
  btn.hidden = !isAdmin();
  btn.textContent = isActiveStore(s) ? 'Mark inactive' : 'Mark active';
  btn.onclick = () => toggleStoreActive(s);

  const showAudits = canAudit();
  $('detailAuditHead').hidden = !showAudits;
  $('detailAuditBtn').hidden = !canAuditStore(s.id);
  $('detailAudits').hidden = !showAudits;
  $('detailAudits').innerHTML = showAudits ? storeAuditsHTML(s) : '';
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
