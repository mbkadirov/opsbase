// Phone notifications (web push) and Telegram linking for CSMD.
import { supabase } from './supabase.js';

const VAPID_PUBLIC_KEY = 'BDrqrnM3ajOLGp6vt9SnBPqSZUqrbeslFtNxSUbhJ22u1qDs_PfqzPgvNb-BkCZdPXbHsjrv5HQZY2U68wRcVNg';
const FN_URL = 'https://njakbmroejvnasvjzefl.supabase.co/functions/v1/notify';

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// 'unsupported' | 'install-first' | 'blocked' | 'on' | 'off'
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIOS() && !isInstalled() ? 'install-first' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function turnOnPush(userId) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('blocked');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  const { error } = await supabase.from('push_subscriptions')
    .upsert({ user_id: userId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' });
  if (error) throw new Error(error.message);
}

export async function turnOffPush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}

let botName = null;
export async function telegramLink() {
  const { data: code, error } = await supabase.rpc('telegram_link_code');
  if (error) throw new Error(error.message);
  if (!botName) {
    const r = await fetch(FN_URL + '?bot').then((x) => x.json()).catch(() => ({}));
    botName = r.username;
  }
  if (!botName) throw new Error('bot');
  return `https://t.me/${botName}?start=${code}`;
}

export async function telegramUnlink() {
  const { error } = await supabase.rpc('telegram_unlink');
  if (error) throw new Error(error.message);
}
