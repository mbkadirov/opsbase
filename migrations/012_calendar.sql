-- CSMD: Calendar. Adds "every month on the Nth weekday" (e.g. 2nd Tuesday, last Friday)
-- lets the app mark tasks that came from a store's monthly calendar email, and lets crew leads
-- see and finish the tasks at their own stores.
-- Run AFTER 007_task_approval.sql. Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

-- repeat = 'monthly_nth': repeat_days = {week, weekday}
--   week:    1–4 = 1st–4th, 5 = last
--   weekday: 0 = Sunday … 6 = Saturday
alter table public.tasks drop constraint if exists tasks_repeat_check;
alter table public.tasks add constraint tasks_repeat_check check (repeat in ('none', 'daily', 'weekly', 'monthly', 'monthly_nth'));

-- 'calendar' = imported from a store's monthly floor care calendar.
alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks add constraint tasks_source_check check (source in ('manual', 'email', 'calendar'));

-- The Nth (or last) given weekday of the month that contains m.
create or replace function public.nth_weekday(m date, wk int, dow int) returns date
language plpgsql immutable as $$
declare
  first date := date_trunc('month', m)::date;
  last date := (date_trunc('month', m) + interval '1 month' - interval '1 day')::date;
  d date;
begin
  if wk >= 5 then
    d := last - ((extract(dow from last)::int - dow + 7) % 7);
  else
    d := first + ((dow - extract(dow from first)::int + 7) % 7) + (wk - 1) * 7;
  end if;
  return d;
end
$$;

-- Same as before, plus monthly_nth.
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
  elsif t.repeat = 'monthly_nth' then
    if t.repeat_days is null or cardinality(t.repeat_days) < 2 then return null; end if;
    m := date_trunc('month', start)::date;
    for k in 0..12 loop
      d := nth_weekday(m, t.repeat_days[1], t.repeat_days[2]);
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

grant execute on function public.nth_weekday(date, int, int), public.task_next_due(public.tasks) to authenticated, service_role;

-- Calendar shows done history further back than the Tasks screen.
create index if not exists task_log_due_idx on public.task_log(due_date);

-- ── Crew leads: see and finish the tasks at the stores they are assigned to ──
-- (Admins and supervisors already see every task. Before this, a crew lead only saw tasks assigned to them.)
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (public.my_role() in ('admin', 'supervisor')
         or assignee_id = auth.uid()
         or (public.my_role() = 'crew_lead' and store_id is not null and public.can_see_store(store_id)));

drop policy if exists task_log_read on public.task_log;
create policy task_log_read on public.task_log for select to authenticated
  using (public.my_role() in ('admin', 'supervisor')
         or exists (select 1 from public.tasks t where t.id = task_id
                    and (t.assignee_id = auth.uid()
                         or (public.my_role() = 'crew_lead' and t.store_id is not null and public.can_see_store(t.store_id)))));

-- Same as 007, plus: a crew lead can finish a task at one of their stores. It still waits for admin approval.
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
  if not (t.assignee_id = auth.uid() or my_role() in ('admin', 'supervisor')
          or (my_role() = 'crew_lead' and t.store_id is not null and can_see_store(t.store_id))) then
    raise exception 'Only the person assigned, the store''s crew lead, a supervisor or an admin can finish this task';
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
grant execute on function public.complete_task(bigint, text) to authenticated, service_role;

-- ── One alert per imported store calendar, not one per task ──
-- Same as 010, but tasks added from a store calendar don't each send a "New task" alert.
create or replace function private.on_task_assign() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.source = 'calendar' and tg_op = 'INSERT' then return new; end if;
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    perform private.notify(new.assignee_id, 'New task' || case when new.store_id is not null then ' · ' || private.store_label(new.store_id) else '' end,
      new.title || coalesce(' · due ' || to_char(new.due_date, 'Mon DD'), ''), '/?screen=tasks');
  end if;
  return new;
end
$$;

-- The app calls this once after importing: "12 calendar tasks · Wegmans #79 · November".
create or replace function public.notify_calendar_import(p_user uuid, p_store text, p_count int, p_month text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if my_role() <> 'admin' then raise exception 'Only an admin can do this'; end if;
  perform private.notify(p_user, 'New store calendar · ' || private.store_label(p_store),
    p_count || ' task' || case when p_count = 1 then '' else 's' end || ' for ' || p_month || '. Open the Calendar to see them.', '/?screen=calendar');
end
$$;
grant execute on function public.notify_calendar_import(uuid, text, int, text) to authenticated;
