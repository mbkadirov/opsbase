-- CSMD: notifications (phone pop-ups + Telegram) for new issues, fixes/tasks waiting for approval, and assigned tasks.
-- Run AFTER deploying the "notify" Edge Function. Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

create extension if not exists pg_net with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Where to send notifications. The secret must match NOTIFY_SECRET in the Edge Function's secrets.
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values
  ('notify_url', 'https://njakbmroejvnasvjzefl.supabase.co/functions/v1/notify'),
  ('notify_secret', 'E9lDrNw_KLEfFU86NQFpD_w5-rxVtuJY')
on conflict (key) do update set value = excluded.value;

-- Telegram link per person. Murod's chat is already known from the daily recap.
alter table public.profiles add column if not exists telegram_chat_id bigint;
alter table public.profiles add column if not exists telegram_code text;
update public.profiles set telegram_chat_id = 171146052 where role = 'admin' and email = 'mbkadirov@gmail.com' and telegram_chat_id is null;

-- Phones that turned on notifications.
create table if not exists public.push_subscriptions (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subscriptions to authenticated, service_role;
grant usage, select on sequence public.push_subscriptions_id_seq to authenticated, service_role;

-- Every notification sent (also lets the app show them later).
create table if not exists public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null,
  body       text not null default '',
  url        text not null default '/',
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists notifications_mark_read on public.notifications;
create policy notifications_mark_read on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, update on public.notifications to authenticated;
grant all on public.notifications to service_role;
grant usage, select on sequence public.notifications_id_seq to service_role;

-- Queue one notification and hand it to the Edge Function (which sends the phone pop-up and Telegram message).
create or replace function private.notify(p_user uuid, p_title text, p_body text, p_url text default '/') returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare nid bigint; u text; s text;
begin
  if p_user is null then return; end if;
  if p_user = auth.uid() then return; end if;  -- don't notify people about their own actions
  if not exists (select 1 from profiles where id = p_user and role in ('admin', 'supervisor', 'crew_lead')) then return; end if;
  insert into notifications (user_id, title, body, url) values (p_user, left(p_title, 120), left(coalesce(p_body, ''), 400), p_url)
    returning id into nid;
  select value into u from private.settings where key = 'notify_url';
  select value into s from private.settings where key = 'notify_secret';
  if u is not null then
    perform net.http_post(url := u, body := jsonb_build_object('notification_id', nid),
                          headers := jsonb_build_object('Content-Type', 'application/json', 'x-csmd-secret', s),
                          timeout_milliseconds := 30000);
  end if;
exception when others then
  raise warning 'CSMD notify failed: %', sqlerrm;  -- never block saving an issue or task
end
$$;

create or replace function private.store_label(p_store text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from stores where id = p_store), p_store, 'No store')
$$;

-- New issue → every admin, and supervisors assigned to that store.
create or replace function private.on_issue_insert() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare r record; lbl text := private.store_label(new.store_id);
begin
  for r in
    select id from profiles where role = 'admin'
    union
    select p.id from profiles p join store_assignments a on a.user_id = p.id
      where p.role = 'supervisor' and a.store_id = new.store_id
  loop
    perform private.notify(r.id,
      case when new.status = 'pending review' then 'Fix waiting for approval · ' else 'New issue · ' end || lbl,
      coalesce(new.category, '') || ': ' || new.description, '/?issue=' || new.id);
  end loop;
  return new;
end
$$;
drop trigger if exists issues_notify_insert on public.issues;
create trigger issues_notify_insert after insert on public.issues
  for each row execute function private.on_issue_insert();

-- Issue fixed by someone → admins (waiting for approval).
create or replace function private.on_issue_update() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare r record;
begin
  if new.status = 'pending review' and old.status is distinct from 'pending review' then
    for r in select id from profiles where role = 'admin' loop
      perform private.notify(r.id, 'Fix waiting for approval · ' || private.store_label(new.store_id),
        coalesce(new.resolved_by_name, 'Someone') || ': ' || coalesce(new.resolution, ''), '/?issue=' || new.id);
    end loop;
  end if;
  return new;
end
$$;
drop trigger if exists issues_notify_update on public.issues;
create trigger issues_notify_update after update of status on public.issues
  for each row execute function private.on_issue_update();

-- Task assigned → the assignee.
create or replace function private.on_task_assign() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform private.notify(new.assignee_id, 'New task' || case when new.store_id is not null then ' · ' || private.store_label(new.store_id) else '' end,
      new.title || coalesce(' · due ' || to_char(new.due_date, 'Mon DD'), ''), '/?screen=tasks');
  end if;
  return new;
end
$$;
drop trigger if exists tasks_notify_assign on public.tasks;
create trigger tasks_notify_assign after insert or update of assignee_id on public.tasks
  for each row execute function private.on_task_assign();

-- Task marked done by the team → admins (waiting for approval).
create or replace function private.on_task_done() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare r record; t tasks%rowtype;
begin
  if new.review = 'pending' then
    select * into t from tasks where id = new.task_id;
    for r in select id from profiles where role = 'admin' loop
      perform private.notify(r.id, 'Task done, waiting for approval',
        coalesce(new.done_by_name, 'Someone') || ': ' || t.title || coalesce(' — ' || new.note, ''), '/?screen=tasks');
    end loop;
  end if;
  return new;
end
$$;
drop trigger if exists task_log_notify on public.task_log;
create trigger task_log_notify after insert on public.task_log
  for each row execute function private.on_task_done();

-- App: get a one-time code to link Telegram (send "/start CODE" to the bot).
create or replace function public.telegram_link_code() returns text
language plpgsql security definer set search_path = public as $$
declare c text := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  update profiles set telegram_code = c where id = auth.uid();
  return c;
end
$$;
create or replace function public.telegram_unlink() returns void
language sql security definer set search_path = public as $$
  update profiles set telegram_chat_id = null, telegram_code = null where id = auth.uid()
$$;
grant execute on function public.telegram_link_code(), public.telegram_unlink() to authenticated;
