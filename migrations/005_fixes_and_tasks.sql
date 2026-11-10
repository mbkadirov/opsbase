-- CSMD: link issues to their email thread, and follow-up tasks with due dates.
-- Run once in Supabase → SQL Editor (paste all, nothing highlighted, Run). Safe to run again.

-- ── Which email thread an issue came from (lets the recap update it later) ──
alter table public.issues add column if not exists source_ref text;
create index if not exists issues_source_ref_idx on public.issues(store_id, source_ref);

-- ── Follow-up tasks ──────────────────────────────────────────────────
create table if not exists public.tasks (
  id              bigserial primary key,
  issue_id        bigint references public.issues(id) on delete cascade,
  store_id        text references public.stores(id) on delete cascade,
  title           text not null,
  assignee_id     uuid references public.profiles(id) on delete set null,
  assignee_name   text not null default '',
  due_date        date,
  status          text not null default 'open' check (status in ('open', 'done')),
  source          text not null default 'manual' check (source in ('manual', 'email')),
  created_by      uuid references public.profiles(id) on delete set null,
  created_by_name text not null default '',
  created_at      timestamptz not null default now(),
  done_at         timestamptz,
  done_by_name    text,
  done_note       text
);
create index if not exists tasks_assignee_idx on public.tasks(assignee_id, status);
create index if not exists tasks_issue_idx on public.tasks(issue_id);

alter table public.tasks enable row level security;

-- Admins and supervisors see every task; everyone else sees tasks assigned to them.
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (public.my_role() in ('admin', 'supervisor') or assignee_id = auth.uid());

-- Only admins create, edit or delete tasks directly. Finishing a task goes through complete_task().
drop policy if exists tasks_admin_write on public.tasks;
create policy tasks_admin_write on public.tasks for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

-- The assignee, a supervisor or an admin can mark a task done, with an optional note.
-- If the task belongs to an issue, the note is added to that issue's activity.
create or replace function public.complete_task(p_task bigint, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare t tasks%rowtype;
begin
  select * into t from tasks where id = p_task;
  if t.id is null then raise exception 'Task not found'; end if;
  if not (t.assignee_id = auth.uid() or my_role() in ('admin', 'supervisor')) then
    raise exception 'Only the person assigned, a supervisor or an admin can finish this task';
  end if;
  if t.status = 'done' then return; end if;
  update tasks set status = 'done', done_at = now(), done_by_name = my_name(), done_note = nullif(trim(coalesce(p_note, '')), '')
    where id = p_task;
  if t.issue_id is not null then
    insert into issue_comments (issue_id, user_id, author_name, kind, body)
      values (t.issue_id, auth.uid(), my_name(), 'comment',
              'Follow-up done: ' || t.title || coalesce(nullif(' — ' || trim(coalesce(p_note, '')), ' — '), ''));
  end if;
end
$$;

create or replace function public.reopen_task(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() not in ('admin', 'supervisor') and not exists (select 1 from tasks where id = p_task and assignee_id = auth.uid()) then
    raise exception 'Not allowed';
  end if;
  update tasks set status = 'open', done_at = null, done_by_name = null, done_note = null where id = p_task;
end
$$;

grant select, insert, update, delete on public.tasks to authenticated, service_role;
grant usage, select on sequence public.tasks_id_seq to authenticated, service_role;
grant execute on function public.complete_task(bigint, text), public.reopen_task(bigint) to authenticated, service_role;
