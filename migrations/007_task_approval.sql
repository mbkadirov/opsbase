-- CSMD: tasks finished by the team wait for an admin to approve, send back, or turn into an issue.
-- Run AFTER 006_repeating_tasks.sql. Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

-- A one-time task finished by someone else waits here until approved.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in ('open', 'pending review', 'done'));

-- Each "done" entry is reviewed: pending → approved | sent_back | issue.
alter table public.task_log add column if not exists review text not null default 'approved';
alter table public.task_log drop constraint if exists task_log_review_check;
alter table public.task_log add constraint task_log_review_check check (review in ('pending', 'approved', 'sent_back', 'issue'));
alter table public.task_log add column if not exists reviewed_by_name text;
alter table public.task_log add column if not exists reviewed_at timestamptz;
alter table public.task_log add column if not exists review_note text;
alter table public.task_log add column if not exists issue_id bigint references public.issues(id) on delete set null;
create index if not exists task_log_review_idx on public.task_log(review) where review = 'pending';

-- Finish a task. Admin: counts as approved right away. Everyone else: waits for approval.
-- A repeating task still moves on to its next date so tomorrow's work shows up.
create or replace function public.complete_task(p_task bigint, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  t tasks%rowtype;
  nxt date;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  admin boolean := my_role() = 'admin';
begin
  select * into t from tasks where id = p_task;
  if t.id is null then raise exception 'Task not found'; end if;
  if not (t.assignee_id = auth.uid() or my_role() in ('admin', 'supervisor')) then
    raise exception 'Only the person assigned, a supervisor or an admin can finish this task';
  end if;
  if t.status <> 'open' then return; end if;

  insert into task_log (task_id, due_date, done_by, done_by_name, note, review, reviewed_by_name, reviewed_at)
    values (t.id, t.due_date, auth.uid(), my_name(), v_note,
            case when admin then 'approved' else 'pending' end,
            case when admin then my_name() end, case when admin then now() end);
  nxt := task_next_due(t);
  if nxt is null then
    update tasks set status = case when admin then 'done' else 'pending review' end,
                     done_at = now(), done_by_name = my_name(), done_note = v_note,
                     last_done_at = now(), last_done_by_name = my_name() where id = p_task;
  else
    update tasks set due_date = nxt, last_done_at = now(), last_done_by_name = my_name(), done_note = v_note where id = p_task;
  end if;

  if t.issue_id is not null then
    insert into issue_comments (issue_id, user_id, author_name, kind, body)
      values (t.issue_id, auth.uid(), my_name(), 'comment',
              'Follow-up done: ' || t.title || coalesce(' — ' || v_note, '') || case when admin then '' else ' (waiting for approval)' end);
  end if;
end
$$;

-- Admin review of one "done" entry.
--   approve   → closes a one-time task
--   sendback  → the task goes back on the list, due that same date, with the admin's v_note
--   issue     → logs a new open issue for the store (p_category, p_note = description); a one-time task closes
-- Returns the new issue id for 'issue', else null.
create or replace function public.review_task(p_log bigint, p_action text, p_note text default '', p_category text default 'Cleaning')
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  l task_log%rowtype;
  t tasks%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  new_issue bigint;
begin
  if my_role() <> 'admin' then raise exception 'Only an admin can review tasks'; end if;
  select * into l from task_log where id = p_log;
  if l.id is null then raise exception 'Not found'; end if;
  if l.review <> 'pending' then raise exception 'This was already reviewed'; end if;
  select * into t from tasks where id = l.task_id;

  if p_action = 'approve' then
    update task_log set review = 'approved', reviewed_by_name = my_name(), reviewed_at = now(), review_note = v_note where id = p_log;
    update tasks set status = 'done' where id = t.id and status = 'pending review';
    return null;

  elsif p_action = 'sendback' then
    if v_note is null or length(v_note) < 3 then raise exception 'Say why it is being sent back'; end if;
    update task_log set review = 'sent_back', reviewed_by_name = my_name(), reviewed_at = now(), review_note = v_note where id = p_log;
    update tasks set status = 'open', done_at = null, done_by_name = null,
                     done_note = 'Sent back: ' || v_note,
                     due_date = least(coalesce(due_date, l.due_date), coalesce(l.due_date, due_date))
      where id = t.id;
    if t.issue_id is not null then
      insert into issue_comments (issue_id, user_id, author_name, kind, body)
        values (t.issue_id, auth.uid(), my_name(), 'sent_back', 'Follow-up sent back: ' || v_note);
    end if;
    return null;

  elsif p_action = 'issue' then
    if t.store_id is null then raise exception 'This task has no store. Edit the task and pick a store first.'; end if;
    if v_note is null or length(v_note) < 5 then raise exception 'Describe the problem for the issue'; end if;
    insert into issues (store_id, category, date, description, status, assignee)
      values (t.store_id, coalesce(nullif(p_category, ''), 'Cleaning'), local_today(), v_note, 'open', nullif(t.assignee_name, ''))
      returning id into new_issue;
    insert into issue_comments (issue_id, user_id, author_name, kind, body)
      values (new_issue, auth.uid(), my_name(), 'comment',
              'Logged from task "' || t.title || '" done by ' || coalesce(nullif(l.done_by_name, ''), 'someone')
              || coalesce(' — their note: ' || l.note, ''));
    update task_log set review = 'issue', reviewed_by_name = my_name(), reviewed_at = now(), review_note = v_note, issue_id = new_issue where id = p_log;
    update tasks set status = 'done' where id = t.id and status = 'pending review';
    update tasks set issue_id = new_issue where id = t.id and issue_id is null;
    return new_issue;
  end if;
  raise exception 'Unknown action';
end
$$;

-- Undo on a finished one-time task (admin, supervisor, or the assignee before it is approved).
create or replace function public.reopen_task(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() not in ('admin', 'supervisor') and not exists (select 1 from tasks where id = p_task and assignee_id = auth.uid() and status = 'pending review') then
    raise exception 'Not allowed';
  end if;
  update tasks set status = 'open', done_at = null, done_by_name = null, done_note = null where id = p_task and status in ('done', 'pending review');
  if found then
    delete from task_log where id = (select id from task_log where task_id = p_task order by done_at desc limit 1);
  end if;
end
$$;

grant execute on function public.complete_task(bigint, text), public.reopen_task(bigint),
                          public.review_task(bigint, text, text, text) to authenticated, service_role;
