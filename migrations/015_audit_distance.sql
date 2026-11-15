-- CSMD: audits allowed within 1 mile of the store (was 0.1 mile).
-- Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.

create or replace function private.check_at_store(p_store text, p_lat double precision, p_lng double precision, p_acc double precision)
returns double precision language plpgsql stable security definer set search_path = public as $$
declare s stores%rowtype; d double precision;
begin
  select * into s from stores where id = p_store;
  if s.id is null then raise exception 'Store not found'; end if;
  if s.lat is null or s.lng is null then raise exception 'NO_STORE_LOCATION: This store''s location isn''t set yet. Ask an admin to set it on the store page.'; end if;
  if p_lat is null or p_lng is null then raise exception 'NO_GPS: Turn on location for CSMD to do an audit.'; end if;
  if coalesce(p_acc, 9999) > 300 then raise exception 'WEAK_GPS: Your phone''s location isn''t exact enough (± % m). Step near the entrance or a window and try again.', round(coalesce(p_acc, 9999)); end if;
  d := meters_between(s.lat, s.lng, p_lat, p_lng);
  if d > 1609 + least(coalesce(p_acc, 0), 50) then
    raise exception 'TOO_FAR: You''re % miles from the store. Audits can only be done at the store (within 1 mile).', round((d / 1609.34)::numeric, 2);
  end if;
  return d;
end
$$;
