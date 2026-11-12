// CSMD notify — sends phone pop-ups (web push) and Telegram messages for rows in public.notifications,
// and links people's Telegram accounts when they send "/start CODE" to the bot.
//
// Supabase → Edge Functions → Deploy a new function → Via Editor → name it "notify" → paste this file → Deploy.
// Then turn OFF "Verify JWT" for it, and add these secrets (Edge Functions → Secrets):
//   NOTIFY_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, TELEGRAM_BOT_TOKEN
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
//
// One-time Telegram setup: open  https://<project>.supabase.co/functions/v1/notify?setup=<NOTIFY_SECRET>  in a browser.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const env = (k: string) => Deno.env.get(k) ?? '';
const SECRET = env('NOTIFY_SECRET');
const BOT = env('TELEGRAM_BOT_TOKEN');
const APP_URL = 'https://opsbase-eight.vercel.app';
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

if (env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY')) {
  webpush.setVapidDetails('mailto:murod@csginc.com', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function telegram(method: string, payload: Record<string, unknown>) {
  if (!BOT) return null;
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return r.json().catch(() => null);
}

// Send one queued notification to every phone the person turned on, and to their Telegram.
async function deliver(id: number) {
  const { data: n } = await db.from('notifications').select('*').eq('id', id).maybeSingle();
  if (!n) return { sent: 0 };
  const [{ data: subs }, { data: prof }] = await Promise.all([
    db.from('push_subscriptions').select('*').eq('user_id', n.user_id),
    db.from('profiles').select('telegram_chat_id').eq('id', n.user_id).maybeSingle()
  ]);
  let sent = 0;
  const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: `csmd-${n.id}` });
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id); // phone turned it off
      else console.error('push failed', code, String(e));
    }
  }
  if (prof?.telegram_chat_id) {
    const r = await telegram('sendMessage', {
      chat_id: prof.telegram_chat_id, parse_mode: 'HTML', disable_web_page_preview: true,
      text: `<b>${esc(n.title)}</b>\n${esc(n.body)}\n<a href="${APP_URL}${n.url}">Open in CSMD</a>`
    });
    if (r?.ok) sent++;
  }
  return { sent };
}

// Telegram → "/start CODE" links that chat to the CSMD account that made the code.
async function telegramUpdate(update: { message?: { chat?: { id: number }; text?: string } }) {
  const chat = update.message?.chat?.id;
  const text = (update.message?.text ?? '').trim();
  if (!chat) return;
  const code = text.match(/^\/start\s+([A-Z0-9]{6,12})$/i)?.[1]?.toUpperCase();
  if (!code) {
    await telegram('sendMessage', { chat_id: chat, text: 'To get CSMD notifications here, open CSMD → your initials (top right) → Connect Telegram.' });
    return;
  }
  const { data: p } = await db.from('profiles').select('id, full_name').eq('telegram_code', code).maybeSingle();
  if (!p) {
    await telegram('sendMessage', { chat_id: chat, text: 'That link has expired. In CSMD, tap Connect Telegram again.' });
    return;
  }
  await db.from('profiles').update({ telegram_chat_id: chat, telegram_code: null }).eq('id', p.id);
  await telegram('sendMessage', { chat_id: chat, text: `Connected. ${p.full_name || 'You'} will get CSMD notifications here.` });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return json({ ok: true });

  // Public: the app asks for the bot's username to build the t.me link.
  if (req.method === 'GET' && url.searchParams.has('bot')) {
    const me = await telegram('getMe', {});
    return json({ username: me?.result?.username ?? null });
  }

  // One-time: point the bot's webhook at this function.
  if (req.method === 'GET' && url.searchParams.get('setup')) {
    if (url.searchParams.get('setup') !== SECRET) return json({ error: 'wrong secret' }, 403);
    const hook = `${env('SUPABASE_URL')}/functions/v1/notify?tg=${encodeURIComponent(SECRET)}`;
    const r = await telegram('setWebhook', { url: hook, allowed_updates: ['message'] });
    const me = await telegram('getMe', {});
    return json({ webhook: r, bot: me?.result?.username ?? null });
  }

  // Telegram webhook.
  if (req.method === 'POST' && url.searchParams.has('tg')) {
    if (url.searchParams.get('tg') !== SECRET) return json({ error: 'forbidden' }, 403);
    await telegramUpdate(await req.json().catch(() => ({})));
    return json({ ok: true });
  }

  // From the database: deliver a notification.
  if (req.method === 'POST') {
    if (!SECRET || req.headers.get('x-csmd-secret') !== SECRET) return json({ error: 'forbidden' }, 403);
    const body = await req.json().catch(() => ({}));
    if (!body.notification_id) return json({ error: 'notification_id missing' }, 400);
    return json(await deliver(Number(body.notification_id)));
  }

  return json({ ok: true, service: 'csmd-notify' });
});
