-- CSMD: Calendar. Adds "every month on the Nth weekday" (e.g. 2nd Tuesday, last Friday)
-- and lets the app mark tasks that came from a store's monthly calendar email.
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
