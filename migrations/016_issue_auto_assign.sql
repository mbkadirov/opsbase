-- CSMD: issues are assigned to the store's supervisors (from Users → each supervisor's stores).
-- If two supervisors cover a store, both are named, e.g. "Davron Saydahmedov & Shawn Bobojonov".
-- Applies to issues recorded automatically (from email), and to any issue saved with no owner.
-- Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

-- The supervisors assigned to a store, by name, joined with " & ".
create or replace function private.store_supervisors(p_store text) returns text
language sql stable security definer set search_path = public as $$
  select nullif(string_agg(coalesce(nullif(trim(p.full_name), ''), split_part(p.email, '@', 1)), ' & ' order by p.full_name), '')
    from store_assignments a join profiles p on p.id = a.user_id
   where a.store_id = p_store and p.role = 'supervisor'
$$;

-- Before a new issue is saved: automatic issues (no person created them in the app) always get the
-- store's supervisors; issues logged in the app keep the owner typed in, or get the supervisors if left blank.
create or replace function private.on_issue_assign() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare sup text := private.store_supervisors(new.store_id);
begin
  if sup is not null and (new.created_by is null or nullif(trim(coalesce(new.assignee, '')), '') is null) then
    new.assignee := sup;
  end if;
  return new;
end
$$;
drop trigger if exists issues_assign_insert on public.issues;
create trigger issues_assign_insert before insert on public.issues
  for each row execute function private.on_issue_assign();

-- Fix the open automatic issues already recorded (like yesterday's #40 one).
update public.issues i
   set assignee = private.store_supervisors(i.store_id)
 where i.created_by is null
   and i.status in ('open', 'in progress')
   and private.store_supervisors(i.store_id) is not null
   and i.assignee is distinct from private.store_supervisors(i.store_id);

-- Check: each active store and who its issues will go to. "(none)" = no supervisor assigned yet.
select s.name, coalesce(private.store_supervisors(s.id), '(none)') as supervisors
  from public.stores s
 where s.active
 order by s.account, s.name;
