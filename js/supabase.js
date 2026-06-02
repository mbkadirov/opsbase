const SUPABASE_URL = 'https://njakbmroejvnasvjzefl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qYWtibXJvZWp2bmFzdmp6ZWZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzQ4MDYsImV4cCI6MjA5NTk1MDgwNn0.GwEtfBQj76iYvHZcCD7Dw6-j5344RTkQf850KULYp3k';

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...options.headers }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

export const db = {
  // STORES
  async getStores(activeOnly = false) {
    let q = 'stores?select=*&order=account,id';
    if (activeOnly) q += '&active=eq.true';
    return sbFetch(q);
  },

  async toggleActive(id, active) {
    return sbFetch(`stores?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ active }) });
  },

  async addStore(store) {
    return sbFetch('stores', { method: 'POST', body: JSON.stringify(store) });
  },

  async deleteStore(id) {
    return sbFetch(`stores?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: '' } });
  },

  // ISSUES
  async getIssues(filters = {}) {
    let q = 'issues?select=*,stores(name,account)&order=date.desc,created_at.desc';
    if (filters.storeId) q += `&store_id=eq.${encodeURIComponent(filters.storeId)}`;
    if (filters.status) q += `&status=eq.${encodeURIComponent(filters.status)}`;
    return sbFetch(q);
  },

  async addIssue(issue) {
    return sbFetch('issues', { method: 'POST', body: JSON.stringify(issue) });
  },

  async updateIssue(id, patch) {
    return sbFetch(`issues?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  async deleteIssue(id) {
    return sbFetch(`issues?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: '' } });
  },

  async getIssueCounts() {
    return sbFetch('issues?select=store_id,status');
  }
};
