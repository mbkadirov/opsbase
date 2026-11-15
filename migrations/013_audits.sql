-- CSMD: Store audits — checklist answers, photos, and a check that the auditor is at the store.
-- Run AFTER 012_calendar.sql. Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

-- ── Store location (for the "within 0.5 mile" check) ──
alter table public.stores add column if not exists lat double precision;
alter table public.stores add column if not exists lng double precision;

-- Admins set a store's location (stores_update already allows only admins).

-- ── Audits ──
create table if not exists public.audits (
  id bigint generated always as identity primary key,
  store_id text not null references public.stores(id) on delete cascade,
  auditor_id uuid references auth.users(id) on delete set null,
  auditor_name text,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  checklist jsonb not null,               -- copy of the questions used, so old audits still read right after the list changes
  answers jsonb not null default '{}',     -- { questionId: { v: 'pass'|'fail'|'na'|1..5|'text', note: '', photos: ['path', ...] } }
  photos jsonb not null default '[]',      -- general photos: ['path', ...]
  score numeric,                           -- 0–100, set when submitted
  started_at timestamptz not null default now(),
  start_lat double precision, start_lng double precision, start_accuracy double precision, start_distance_m double precision,
  submitted_at timestamptz,
  submit_lat double precision, submit_lng double precision, submit_accuracy double precision, submit_distance_m double precision,
  updated_at timestamptz not null default now()
);
create index if not exists audits_store_idx on public.audits(store_id, started_at desc);
create index if not exists audits_auditor_idx on public.audits(auditor_id);

alter table public.audits enable row level security;
grant select, insert, update, delete on public.audits to authenticated;

-- Admins see all audits. Supervisors see their own and those for stores assigned to them.
drop policy if exists audits_read on public.audits;
create policy audits_read on public.audits for select to authenticated
  using (public.my_role() = 'admin' or auditor_id = auth.uid()
         or (public.my_role() = 'supervisor' and exists (select 1 from public.store_assignments a where a.user_id = auth.uid() and a.store_id = audits.store_id)));

-- Starting an audit goes through start_audit() below (it checks the location), so no direct inserts.
drop policy if exists audits_insert on public.audits;

-- The auditor fills in their own draft. Submitting goes through submit_audit().
drop policy if exists audits_update on public.audits;
create policy audits_update on public.audits for update to authenticated
  using (auditor_id = auth.uid() and status = 'draft')
  with check (auditor_id = auth.uid() and status = 'draft');

drop policy if exists audits_delete on public.audits;
create policy audits_delete on public.audits for delete to authenticated
  using (public.my_role() = 'admin' or (auditor_id = auth.uid() and status = 'draft'));

-- ── Distance in meters between two points ──
create or replace function public.meters_between(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- 0.5 mile = 805 m. Phones are less exact indoors, so up to 50 m of the reported accuracy is allowed on top.
-- A fix less exact than 300 m is refused (move near a window or the entrance and try again).
create or replace function private.check_at_store(p_store text, p_lat double precision, p_lng double precision, p_acc double precision)
returns double precision language plpgsql stable security definer set search_path = public as $$
declare s stores%rowtype; d double precision;
begin
  select * into s from stores where id = p_store;
  if s.id is null then raise exception 'Store not found'; end if;
  if s.lat is null or s.lng is null then raise exception 'NO_STORE_LOCATION: This store''s location isn''t set yet. Ask an admin to set it on the store page.'; end if;
  if p_lat is null or p_lng is null then raise exception 'NO_GPS: Turn on location for CSMD to do an audit.'; end if;
  if coalesce(p_acc, 9999) > 300 then raise exception 'WEAK_GPS: Your phone''s location isn''t exact enough (± % m). Step near the entrance or a window and try again.', round(coalesce(p_acc, 9999)); end if;
  d := meters_between(s.lat, s.lng, p_lat, p_lng);
  if d > 805 + least(coalesce(p_acc, 0), 50) then
    raise exception 'TOO_FAR: You''re % miles from the store. Audits can only be done at the store (within 0.5 mile).', round((d / 1609.34)::numeric, 2);
  end if;
  return d;
end
$$;

create or replace function public.start_audit(p_store text, p_checklist jsonb, p_lat double precision, p_lng double precision, p_acc double precision)
returns bigint language plpgsql security definer set search_path = public, private as $$
declare d double precision; new_id bigint;
begin
  if my_role() not in ('admin', 'supervisor') then raise exception 'Only supervisors and admins can do audits'; end if;
  if my_role() = 'supervisor' and not exists (select 1 from store_assignments where user_id = auth.uid() and store_id = p_store) then
    raise exception 'This store isn''t assigned to you. Ask an admin to add it under Users.';
  end if;
  d := private.check_at_store(p_store, p_lat, p_lng, p_acc);
  insert into audits (store_id, auditor_id, auditor_name, checklist, start_lat, start_lng, start_accuracy, start_distance_m)
    values (p_store, auth.uid(), my_name(), p_checklist, p_lat, p_lng, p_acc, d)
    returning id into new_id;
  return new_id;
end
$$;

create or replace function public.submit_audit(p_id bigint, p_score numeric, p_lat double precision, p_lng double precision, p_acc double precision)
returns void language plpgsql security definer set search_path = public, private as $$
declare a audits%rowtype; d double precision;
begin
  select * into a from audits where id = p_id;
  if a.id is null then raise exception 'Audit not found'; end if;
  if a.auditor_id is distinct from auth.uid() then raise exception 'Only the person doing this audit can submit it'; end if;
  if a.status <> 'draft' then return; end if;
  d := private.check_at_store(a.store_id, p_lat, p_lng, p_acc);
  update audits set status = 'submitted', score = greatest(0, least(100, p_score)), submitted_at = now(),
    submit_lat = p_lat, submit_lng = p_lng, submit_accuracy = p_acc, submit_distance_m = d, updated_at = now()
    where id = p_id;
end
$$;

grant execute on function public.meters_between(double precision, double precision, double precision, double precision) to authenticated;
grant execute on function public.start_audit(text, jsonb, double precision, double precision, double precision) to authenticated;
grant execute on function public.submit_audit(bigint, numeric, double precision, double precision, double precision) to authenticated;

-- ── Photos: private storage bucket "audits", files under <audit id>/ ──
insert into storage.buckets (id, name, public) values ('audits', 'audits', false) on conflict (id) do nothing;

drop policy if exists audit_photos_read on storage.objects;
create policy audit_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'audits' and exists (select 1 from public.audits a where a.id::text = split_part(name, '/', 1)));
  -- (audits_read decides which audits the person can see)

drop policy if exists audit_photos_add on storage.objects;
create policy audit_photos_add on storage.objects for insert to authenticated
  with check (bucket_id = 'audits' and exists (select 1 from public.audits a where a.id::text = split_part(name, '/', 1)
                                                and a.auditor_id = auth.uid() and a.status = 'draft'));

drop policy if exists audit_photos_remove on storage.objects;
create policy audit_photos_remove on storage.objects for delete to authenticated
  using (bucket_id = 'audits' and (public.my_role() = 'admin' or exists (select 1 from public.audits a where a.id::text = split_part(name, '/', 1)
                                                and a.auditor_id = auth.uid() and a.status = 'draft')));
