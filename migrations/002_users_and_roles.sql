-- OpsBase: user accounts and roles.
-- Run once in Supabase → SQL Editor → New query → paste all of this → Run.
-- Safe to run again. Does NOT delete any stores or issues.
--
-- Roles
--   admin       everything: all stores, issues, users, add/deactivate stores
--   supervisor  all stores; log, edit, resolve and delete issues; sees the user list
--   crew_lead   only the stores assigned to them; log, edit and resolve issues there
--   pending     signed up but not approved yet — sees nothing
--   disabled    access removed — sees nothing
-- The first account created after this runs becomes admin. Everyone after that
-- starts as pending until an admin approves them in OpsBase → Users.

-- ── Tables ────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text not null default '',
  role       text not null default 'pending'
             check (role in ('admin', 'supervisor', 'crew_lead', 'pending', 'disabled')),
  created_at timestamptz not null default now()
);

create table if not exists public.store_assignments (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  store_id text not null references public.stores(id) on delete cascade,
  primary key (user_id, store_id)
);
create index if not exists store_assignments_store_idx on public.store_assignments(store_id);

-- ── Helper functions (run with owner rights so policies can use them) ─
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from profiles where id = auth.uid()), 'none')
$$;

create or replace function public.can_see_store(sid text) returns boolean
language sql stable security definer set search_path = public as $$
  select case my_role()
    when 'admin'      then true
    when 'supervisor' then true
    when 'crew_lead'  then exists (select 1 from store_assignments where user_id = auth.uid() and store_id = sid)
    else false
  end
$$;

-- Lets anyone signed in change their own display name (and nothing else on their profile).
create or replace function public.set_my_name(new_name text) returns void
language sql volatile security definer set search_path = public as $$
  update profiles set full_name = left(trim(new_name), 80) where id = auth.uid()
$$;

-- New accounts get a profile automatically. First one ever is admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when exists (select 1 from profiles where role = 'admin') then 'pending' else 'admin' end
  )
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts that already existed before this ran get a pending profile.
insert into public.profiles (id, email, role)
select u.id, u.email, 'pending' from auth.users u
on conflict (id) do nothing;

-- ── Access rules ──────────────────────────────────────────────────────
alter table public.stores            enable row level security;
alter table public.issues            enable row level security;
alter table public.profiles          enable row level security;
alter table public.store_assignments enable row level security;

-- Remove the old "anyone on the internet can read and change everything" rules.
drop policy if exists "Public read stores"   on public.stores;
drop policy if exists "Public insert stores" on public.stores;
drop policy if exists "Public update stores" on public.stores;
drop policy if exists "Public delete stores" on public.stores;
drop policy if exists "Public read issues"   on public.issues;
drop policy if exists "Public insert issues" on public.issues;
drop policy if exists "Public update issues" on public.issues;
drop policy if exists "Public delete issues" on public.issues;

-- Stores: see the ones you have access to; only admins add or change stores.
drop policy if exists stores_read   on public.stores;
drop policy if exists stores_insert on public.stores;
drop policy if exists stores_update on public.stores;
drop policy if exists stores_delete on public.stores;
create policy stores_read   on public.stores for select to authenticated using (public.can_see_store(id));
create policy stores_insert on public.stores for insert to authenticated with check (public.my_role() = 'admin');
create policy stores_update on public.stores for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
create policy stores_delete on public.stores for delete to authenticated using (public.my_role() = 'admin');

-- Issues: read, log and update at your stores; only admins and supervisors delete.
drop policy if exists issues_read   on public.issues;
drop policy if exists issues_insert on public.issues;
drop policy if exists issues_update on public.issues;
drop policy if exists issues_delete on public.issues;
create policy issues_read   on public.issues for select to authenticated using (public.can_see_store(store_id));
create policy issues_insert on public.issues for insert to authenticated with check (public.can_see_store(store_id));
create policy issues_update on public.issues for update to authenticated using (public.can_see_store(store_id)) with check (public.can_see_store(store_id));
create policy issues_delete on public.issues for delete to authenticated using (public.my_role() in ('admin', 'supervisor'));

-- Profiles: you see yourself; admins and supervisors see everyone; only admins change roles.
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select to authenticated using (id = auth.uid() or public.my_role() in ('admin', 'supervisor'));
create policy profiles_update on public.profiles for update to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- Store assignments: you see your own; admins and supervisors see all; only admins change them.
drop policy if exists assignments_read  on public.store_assignments;
drop policy if exists assignments_write on public.store_assignments;
create policy assignments_read  on public.store_assignments for select to authenticated using (user_id = auth.uid() or public.my_role() in ('admin', 'supervisor'));
create policy assignments_write on public.store_assignments for all    to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');
