-- OpsBase: resolution notes, comments, and admin approval before an issue is closed.
-- Run once in Supabase → SQL Editor (paste the whole file, nothing highlighted, Run). Safe to run again.
--
-- Flow:  open → in progress → [someone resolves, with a note] → pending review → [admin approves] → resolved
--                                                                          └→ [admin sends back, with a reason] → in progress
-- An admin who resolves an issue closes it straight away. Only an admin can reopen a resolved issue.
-- The 7pm recap script (secret key, no signed-in user) is not affected.

-- ── Who resolved / approved ───────────────────────────────────────────
alter table public.issues add column if not exists resolution       text;
alter table public.issues add column if not exists resolved_by      uuid references public.profiles(id) on delete set null;
alter table public.issues add column if not exists resolved_by_name text;
alter table public.issues add column if not exists resolved_at      timestamptz;
alter table public.issues add column if not exists approved_by      uuid references public.profiles(id) on delete set null;
alter table public.issues add column if not exists approved_by_name text;
alter table public.issues add column if not exists approved_at      timestamptz;

-- ── Comments and history ──────────────────────────────────────────────
create table if not exists public.issue_comments (
  id          bigserial primary key,
  issue_id    bigint not null references public.issues(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  author_name text not null default '',
  kind        text not null default 'comment'
              check (kind in ('comment', 'resolution', 'approved', 'sent_back', 'reopened')),
  body        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists issue_comments_issue_idx on public.issue_comments(issue_id, created_at);

alter table public.issue_comments enable row level security;
drop policy if exists comments_read on public.issue_comments;
create policy comments_read on public.issue_comments for select to authenticated
  using (exists (select 1 from public.issues i where i.id = issue_id and public.can_see_store(i.store_id)));
-- Comments are only written through the functions below.

-- ── Helpers ───────────────────────────────────────────────────────────
create or replace function public.my_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(full_name, ''), email, 'Unknown') from profiles where id = auth.uid()
$$;

-- Blocks closing or reopening an issue by editing it directly. Signed-in users must go
-- through the functions below; the recap script (no signed-in user) is let through.
create or replace function public.guard_issue_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_setting('opsbase.via_fn', true) = '1' then
    return new;
  end if;
  if new.status is distinct from old.status
     and (new.status in ('resolved', 'pending review') or old.status in ('resolved', 'pending review')) then
    raise exception 'Use Resolve, Approve, Send back or Reopen to change this status';
  end if;
  if tg_op = 'UPDATE' and (new.resolved_by is distinct from old.resolved_by or new.approved_by is distinct from old.approved_by) then
    raise exception 'Resolution details can only be set by Resolve or Approve';
  end if;
  return new;
end
$$;

drop trigger if exists issues_guard_status on public.issues;
create trigger issues_guard_status before update on public.issues
  for each row execute function public.guard_issue_status();

create or replace function public.guard_issue_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.status in ('resolved', 'pending review') then
    new.status := 'open';
  end if;
  return new;
end
$$;

drop trigger if exists issues_guard_insert on public.issues;
create trigger issues_guard_insert before insert on public.issues
  for each row execute function public.guard_issue_insert();

-- ── Actions ───────────────────────────────────────────────────────────
create or replace function public.resolve_issue(p_issue bigint, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_store text; v_status text; v_admin boolean := my_role() = 'admin'; v_new text;
begin
  select store_id, status into v_store, v_status from issues where id = p_issue;
  if v_store is null or not can_see_store(v_store) then raise exception 'Issue not found'; end if;
  if v_status not in ('open', 'in progress') then raise exception 'This issue is already %', v_status; end if;
  if length(trim(coalesce(p_note, ''))) < 5 then raise exception 'Describe what was done to fix it'; end if;
  v_new := case when v_admin then 'resolved' else 'pending review' end;
  perform set_config('opsbase.via_fn', '1', true);
  update issues set
    status = v_new, resolution = trim(p_note),
    resolved_by = auth.uid(), resolved_by_name = my_name(), resolved_at = now(),
    approved_by      = case when v_admin then auth.uid() end,
    approved_by_name = case when v_admin then my_name() end,
    approved_at      = case when v_admin then now() end,
    updated_at = now()
  where id = p_issue;
  insert into issue_comments (issue_id, user_id, author_name, kind, body)
    values (p_issue, auth.uid(), my_name(), 'resolution', trim(p_note));
  return v_new;
end
$$;

create or replace function public.review_issue(p_issue bigint, p_approve boolean, p_note text default '') returns text
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if my_role() <> 'admin' then raise exception 'Only an admin can approve or send back'; end if;
  select status into v_status from issues where id = p_issue;
  if v_status is null then raise exception 'Issue not found'; end if;
  if v_status <> 'pending review' then raise exception 'This issue is not waiting for approval'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why it is being sent back'; end if;
  perform set_config('opsbase.via_fn', '1', true);
  if p_approve then
    update issues set status = 'resolved', approved_by = auth.uid(), approved_by_name = my_name(), approved_at = now(), updated_at = now()
      where id = p_issue;
  else
    update issues set status = 'in progress', approved_by = null, approved_by_name = null, approved_at = null, updated_at = now()
      where id = p_issue;
  end if;
  insert into issue_comments (issue_id, user_id, author_name, kind, body)
    values (p_issue, auth.uid(), my_name(), case when p_approve then 'approved' else 'sent_back' end, trim(coalesce(p_note, '')));
  return case when p_approve then 'resolved' else 'in progress' end;
end
$$;

create or replace function public.reopen_issue(p_issue bigint, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'admin' then raise exception 'Only an admin can reopen a closed issue'; end if;
  if not exists (select 1 from issues where id = p_issue and status = 'resolved') then raise exception 'Issue is not closed'; end if;
  perform set_config('opsbase.via_fn', '1', true);
  update issues set status = 'open', approved_by = null, approved_by_name = null, approved_at = null, updated_at = now()
    where id = p_issue;
  insert into issue_comments (issue_id, user_id, author_name, kind, body)
    values (p_issue, auth.uid(), my_name(), 'reopened', trim(coalesce(p_note, '')));
end
$$;

create or replace function public.add_issue_comment(p_issue bigint, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare v_store text;
begin
  select store_id into v_store from issues where id = p_issue;
  if v_store is null or not can_see_store(v_store) then raise exception 'Issue not found'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'Write a comment first'; end if;
  insert into issue_comments (issue_id, user_id, author_name, kind, body)
    values (p_issue, auth.uid(), my_name(), 'comment', left(trim(p_body), 2000));
end
$$;

revoke execute on function public.resolve_issue(bigint, text), public.review_issue(bigint, boolean, text),
  public.reopen_issue(bigint, text), public.add_issue_comment(bigint, text) from anon;
