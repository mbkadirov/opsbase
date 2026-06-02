import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://njakbmroejvnasvjzefl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qYWtibXJvZWp2bmFzdmp6ZWZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzQ4MDYsImV4cCI6MjA5NTk1MDgwNn0.GwEtfBQj76iYvHZcCD7Dw6-j5344RTkQf850KULYp3k';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
