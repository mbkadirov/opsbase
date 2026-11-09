import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = 'https://njakbmroejvnasvjzefl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_O6asBhYcFBFUTkwCtNILXQ_pF-nzmVJ';

// The signed-in user's session is sent with every request, so the database's
// access rules (see migrations/002_users_and_roles.sql) decide what each person sees.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const SITE = window.location.origin;

export const auth = {
  async session() { return check(await supabase.auth.getSession()).session; },
  onChange(fn) { return supabase.auth.onAuthStateChange(fn); },
  async signIn(email, password) { return check(await supabase.auth.signInWithPassword({ email, password })); },
  async signUp(email, password, fullName) {
    return check(await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: SITE } }));
  },
  async sendLink(email) { return check(await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: SITE } })); },
  async sendReset(email) { return check(await supabase.auth.resetPasswordForEmail(email, { redirectTo: SITE })); },
  async setPassword(password) { return check(await supabase.auth.updateUser({ password })); },
  async signOut() { return check(await supabase.auth.signOut()); }
};

export const db = {
  async getStores() {
    return check(await supabase.from('stores').select('*').order('account').order('id'));
  },
  async addStore(store) { return check(await supabase.from('stores').insert(store).select()); },
  async toggleActive(id, active) { return check(await supabase.from('stores').update({ active }).eq('id', id).select()); },

  async getIssues() {
    return check(await supabase.from('issues').select('*').order('date', { ascending: false }).order('created_at', { ascending: false }));
  },
  async addIssue(issue) { return check(await supabase.from('issues').insert(issue).select()); },
  async updateIssue(id, patch) { return check(await supabase.from('issues').update(patch).eq('id', id).select()); },
  async deleteIssue(id) {
    const rows = check(await supabase.from('issues').delete().eq('id', id).select('id'));
    if (!rows.length) throw new Error('not allowed');
  },

  async myProfile(uid) { return check(await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()); },
  async setMyName(name) { return check(await supabase.rpc('set_my_name', { new_name: name })); },
  async getProfiles() { return check(await supabase.from('profiles').select('*').order('created_at')); },
  async setRole(id, role) {
    const rows = check(await supabase.from('profiles').update({ role }).eq('id', id).select('id'));
    if (!rows.length) throw new Error('not allowed');
  },
  async getAssignments() { return check(await supabase.from('store_assignments').select('*')); },
  async setAssignments(userId, storeIds) {
    check(await supabase.from('store_assignments').delete().eq('user_id', userId));
    if (storeIds.length) check(await supabase.from('store_assignments').insert(storeIds.map((store_id) => ({ user_id: userId, store_id }))));
  }
};
