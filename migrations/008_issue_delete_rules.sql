-- CSMD: who can delete an issue.
--   Admin: any issue.
--   Supervisor: only issues they logged themselves.
--   Issues logged by an admin or by the 7pm email recap: admin only.
-- Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

alter table public.issues add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.issues add column if not exists created_by_name text;

-- Stamp who logged each new issue (empty for the email recap). Can't be faked from the app.
create or replace function public.stamp_issue_creator() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := auth.uid();
  new.created_by_name := case when auth.uid() is null then coalesce(nullif(new.created_by_name, ''), 'Email recap') else my_name() end;
  return new;
end
$$;
drop trigger if exists issues_stamp_creator on public.issues;
create trigger issues_stamp_creator before insert on public.issues
  for each row execute function public.stamp_issue_creator();

drop policy if exists issues_delete on public.issues;
create policy issues_delete on public.issues for delete to authenticated
  using (public.my_role() = 'admin'
         or (public.my_role() = 'supervisor' and created_by = auth.uid()));
