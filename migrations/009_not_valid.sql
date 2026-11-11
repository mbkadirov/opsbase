-- CSMD: an admin can mark an issue "Not valid" (the store was wrong). It costs no health-score points
-- and stays on record with the reason. An admin can reopen it.
-- Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

alter table public.issue_comments drop constraint if exists issue_comments_kind_check;
alter table public.issue_comments add constraint issue_comments_kind_check
  check (kind in ('comment', 'resolution', 'approved', 'sent_back', 'reopened', 'invalid'));

-- Status changes into or out of "not valid" only happen through the functions below.
create or replace function public.guard_issue_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_setting('opsbase.via_fn', true) = '1' then
    return new;
  end if;
  if new.status is distinct from old.status
     and (new.status in ('resolved', 'pending review', 'not valid') or old.status in ('resolved', 'pending review', 'not valid')) then
    raise exception 'Use Resolve, Approve, Send back, Not valid or Reopen to change this status';
  end if;
  if tg_op = 'UPDATE' and (new.resolved_by is distinct from old.resolved_by or new.approved_by is distinct from old.approved_by) then
    raise exception 'Resolution details can only be set by Resolve or Approve';
  end if;
  return new;
end
$$;

create or replace function public.invalidate_issue(p_issue bigint, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if my_role() <> 'admin' then raise exception 'Only an admin can mark an issue not valid'; end if;
  if v_note is null or length(v_note) < 3 then raise exception 'Say why it is not valid'; end if;
  if not exists (select 1 from issues where id = p_issue and status <> 'not valid') then raise exception 'Issue not found'; end if;
  perform set_config('opsbase.via_fn', '1', true);
  update issues set status = 'not valid', approved_by = auth.uid(), approved_by_name = my_name(), approved_at = now(),
                    updated_at = now()
    where id = p_issue;
  insert into issue_comments (issue_id, user_id, author_name, kind, body)
    values (p_issue, auth.uid(), my_name(), 'invalid', left(v_note, 2000));
  -- its open follow-ups are no longer needed
  update tasks set status = 'done', done_at = now(), done_by_name = my_name(), done_note = 'Issue marked not valid'
    where issue_id = p_issue and status in ('open', 'pending review');
end
$$;

-- Reopen works on resolved and not-valid issues.
create or replace function public.reopen_issue(p_issue bigint, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'admin' then raise exception 'Only an admin can reopen a closed issue'; end if;
  if not exists (select 1 from issues where id = p_issue and status in ('resolved', 'not valid')) then raise exception 'Issue is not closed'; end if;
  perform set_config('opsbase.via_fn', '1', true);
  update issues set status = 'open', approved_by = null, approved_by_name = null, approved_at = null, updated_at = now()
    where id = p_issue;
  insert into issue_comments (issue_id, user_id, author_name, kind, body)
    values (p_issue, auth.uid(), my_name(), 'reopened', trim(coalesce(p_note, '')));
end
$$;

grant execute on function public.invalidate_issue(bigint, text), public.reopen_issue(bigint, text) to authenticated, service_role;
