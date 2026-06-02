import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://njakbmroejvnasvjzefl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qYWtibXJvZWp2bmFzdmp6ZWZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzQ4MDYsImV4cCI6MjA5NTk1MDgwNn0.GwEtfBQj76iYvHZcCD7Dw6-j5344RTkQf850KULYp3k';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export const db = {
  async getStores(activeOnly = false) {
    let query = supabase.from('stores').select('*').order('account').order('id');
    if (activeOnly) query = query.eq('active', true);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
  },

  async addStore(store) {
    const { data, error } = await supabase.from('stores').insert(store).select();
    if (error) throw new Error(error.message);
    return data;
  },

  async toggleActive(id, active) {
    const { data, error } = await supabase.from('stores').update({ active }).eq('id', id).select();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteStore(id) {
    const { error } = await supabase.from('stores').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async getIssues(filters = {}) {
    let query = supabase
      .from('issues')
      .select('*, stores(name, account)')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false });
    if (filters.storeId) query = query.eq('store_id', filters.storeId);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
  },

  async addIssue(issue) {
    const { data, error } = await supabase.from('issues').insert(issue).select();
    if (error) throw new Error(error.message);
    return data;
  },

  async updateIssue(id, patch) {
    const { data, error } = await supabase.from('issues').update(patch).eq('id', id).select();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteIssue(id) {
    const { error } = await supabase.from('issues').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async getIssueCounts() {
    const { data, error } = await supabase.from('issues').select('store_id, status');
    if (error) throw new Error(error.message);
    return data;
  }
};
