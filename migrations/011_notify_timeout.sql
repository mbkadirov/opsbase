-- CSMD: give the notify function 30 seconds to answer (it can take more than the default 5 seconds to wake up,
-- and a timed-out call was dropped, so no notification went out). Then show the last few delivery attempts.
-- Paste all in Supabase → SQL Editor, nothing highlighted, Run.

create or replace function private.notify(p_user uuid, p_title text, p_body text, p_url text default '/') returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare nid bigint; u text; s text;
begin
  if p_user is null then return; end if;
  if p_user = auth.uid() then return; end if;  -- don't notify people about their own actions
  if not exists (select 1 from profiles where id = p_user and role in ('admin', 'supervisor', 'crew_lead')) then return; end if;
  insert into notifications (user_id, title, body, url) values (p_user, left(p_title, 120), left(coalesce(p_body, ''), 400), p_url)
    returning id into nid;
  select value into u from private.settings where key = 'notify_url';
  select value into s from private.settings where key = 'notify_secret';
  if u is not null then
    perform net.http_post(url := u, body := jsonb_build_object('notification_id', nid),
                          headers := jsonb_build_object('Content-Type', 'application/json', 'x-csmd-secret', s),
                          timeout_milliseconds := 30000);
  end if;
exception when others then
  raise warning 'CSMD notify failed: %', sqlerrm;  -- never block saving an issue or task
end
$$;

select id, status_code, timed_out, left(coalesce(error_msg, content::text), 120) as result, created
from net._http_response order by id desc limit 8;
