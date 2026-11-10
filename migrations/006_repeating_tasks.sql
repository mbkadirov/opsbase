-- CSMD: repeating tasks (every day, chosen weekdays, monthly) and a log of each time a task is done.
-- Run once in Supabase → SQL Editor (paste all, nothing highlighted, Run). Safe to run again.

-- repeat:       none | daily | weekly | monthly
-- repeat_days:  weekly → weekdays to repeat on (0 = Sunday … 6 = Saturday); monthly → {day of month}
-- repeat_until: last date it can come due (empty = keeps going)
alter table public.tasks add column if not exists repeat text not null default 'none';
alter table public.tasks add column if not exists repeat_days smallint[];
alter table public.tasks add column if not exists repeat_until date;
alter table public.tasks add column if not exists last_done_at timestamptz;
alter table public.tasks add column if not exists last_done_by_name text;
alter table public.tasks drop constraint if exists tasks_repeat_check;
alter table public.tasks add constraint tasks_repeat_check check (repeat in ('none', 'daily', 'weekly', 'monthly'));
alter table public.tasks alter column store_id drop not null;

-- Every time a task is finished (one line per day for a daily task).
create table if not exists public.task_log (
  id           bigserial primary key,
  task_id      bigint not null references public.tasks(id) on delete cascade,
  due_date     date,
  done_at      timestamptz not null default now(),
  done_by      uuid references public.profiles(id) on delete set null,
  done_by_name text not null default '',
  note         text
);
create index if not exists task_log_task_idx on public.task_log(task_id, done_at desc);
alter table public.task_log enable row level security;
drop policy if exists task_log_read on public.task_log;
create policy task_log_read on public.task_log for select to authenticated
  using (public.my_role() in ('admin', 'supervisor')
         or exists (select 1 from public.tasks t where t.id = task_id and t.assignee_id = auth.uid()));

-- Today in Murod's time zone, so "due today" flips at midnight Eastern, not UTC.
create or replace function public.local_today() returns date
language sql stable as $$ select (now() at time zone 'America/New_York')::date $$;

-- The next date a repeating task comes due: after its current due date, and not before today.
-- Returns null when there is no next date (one-time task, or past repeat_until).
create or replace function public.task_next_due(t public.tasks) returns date
language plpgsql stable as $$
declare
  start date := greatest(coalesce(t.due_date, local_today()) + 1, local_today());
  d date;
  dom int;
  m date;
begin
  if t.repeat = 'daily' then
    d := start;
  elsif t.repeat = 'weekly' then
    if t.repeat_days is null or cardinality(t.repeat_days) = 0 then return null; end if;
    for k in 0..6 loop
      if extract(dow from start + k)::int = any(t.repeat_days) then d := start + k; exit; end if;
    end loop;
  elsif t.repeat = 'monthly' then
    dom := coalesce(t.repeat_days[1], extract(day from coalesce(t.due_date, start))::int);
    m := date_trunc('month', start)::date;
    for k in 0..12 loop
      d := least(m + (dom - 1), (m + interval '1 month' - interval '1 day')::date);
      exit when d >= start;
      m := (m + interval '1 month')::date;
    end loop;
  else
    return null;
  end if;
  if t.repeat_until is not null and d > t.repeat_until then return null; end if;
  return d;
end
$$;

-- Finish a task. A repeating task moves on to its next date and stays open; a one-time task closes.
create or replace function public.complete_task(p_task bigint, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  t tasks%rowtype;
  nxt date;
  note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into t from tasks where id = p_task;
  if t.id is null then raise exception 'Task not found'; end if;
  if not (t.assignee_id = auth.uid() or my_role() in ('admin', 'supervisor')) then
    raise exception 'Only the person assigned, a supervisor or an admin can finish this task';
  end if;
  if t.status = 'done' then return; end if;

  insert into task_log (task_id, due_date, done_by, done_by_name, note) values (t.id, t.due_date, auth.uid(), my_name(), note);
  nxt := task_next_due(t);
  if nxt is null then
    update tasks set status = 'done', done_at = now(), done_by_name = my_name(), done_note = note,
                     last_done_at = now(), last_done_by_name = my_name() where id = p_task;
  else
    update tasks set due_date = nxt, last_done_at = now(), last_done_by_name = my_name(), done_note = note where id = p_task;
  end if;

  if t.issue_id is not null then
    insert into issue_comments (issue_id, user_id, author_name, kind, body)
      values (t.issue_id, auth.uid(), my_name(), 'comment',
              'Follow-up done: ' || t.title || coalesce(' — ' || note, ''));
  end if;
end
$$;

grant select on public.task_log to authenticated, service_role;
grant insert, update, delete on public.task_log to service_role;
grant usage, select on sequence public.task_log_id_seq to service_role;
grant execute on function public.local_today(), public.task_next_due(public.tasks) to authenticated, service_role;
grant execute on function public.complete_task(bigint, text) to authenticated, service_role;

-- Undo on a finished one-time task: reopen it and remove its last "done" line.
create or replace function public.reopen_task(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() not in ('admin', 'supervisor') and not exists (select 1 from tasks where id = p_task and assignee_id = auth.uid()) then
    raise exception 'Not allowed';
  end if;
  update tasks set status = 'open', done_at = null, done_by_name = null, done_note = null where id = p_task and status = 'done';
  if found then
    delete from task_log where id = (select id from task_log where task_id = p_task order by done_at desc limit 1);
  end if;
end
$$;
grant execute on function public.reopen_task(bigint) to authenticated, service_role;
