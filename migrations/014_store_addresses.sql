-- CSMD: street addresses for Wegmans and Zara stores (looked up Nov 2026).
-- Paste all in Supabase → SQL Editor, nothing highlighted, Run. Safe to run again.
-- After this, open CSMD → Stores → "Set store locations" to turn the addresses into map pins for audits.

with a(acct, num, addr) as (values
  ('Wegmans', '8',    '2 Centerton Rd, Mount Laurel, NJ 08054'),
  ('Wegmans', '9',    '1104 Highway 35, Ocean, NJ 07712'),
  ('Wegmans', '10',   '2100 Route 70 W, Cherry Hill, NJ 08002'),
  ('Wegmans', '14',   '122 Shawan Rd, Hunt Valley, MD 21030'),
  ('Wegmans', '32',   '15 Woodbridge Center Dr, Woodbridge, NJ 07095'),
  ('Wegmans', '40',   '9001 McHugh Dr, Lanham, MD 20706'),
  ('Wegmans', '43',   '600 Commerce Dr, Collegeville, PA 19426'),
  ('Wegmans', '45',   '6416 Carlisle Pike, Mechanicsburg, PA 17050'),
  ('Wegmans', '53',   '21 Wegmans Blvd, Abingdon, MD 21009'),
  ('Wegmans', '79',   '3900 W Tilghman St, Allentown, PA 18104'),
  ('Wegmans', '97',   '5000 Wegmans Dr, Bethlehem, PA 18017'),
  ('Wegmans', '104',  '500 Montgomery Mall, North Wales, PA 19454'),
  ('Wegmans', '125',  '10100 Reisterstown Rd, Owings Mills, MD 21117'),
  ('Wegmans', '135',  '2000 Crossings Blvd, Lancaster, PA 17601'),
  ('Wegmans', '152',  '925 Vansant Dr, Yardley, PA 19067'),
  ('Wegmans', '1004', '2110 Route 70 W, Cherry Hill, NJ 08002'),
  ('Zara',    '7999', '2002 Annapolis Mall Rd, Annapolis, MD 21401'),
  ('Zara',    '10836','825 Dulaney Valley Rd, Towson, MD 21204')
)
update public.stores s
   set address = a.addr,
       lat = null, lng = null          -- re-pin from the new address
  from a
 where s.account ilike a.acct || '%'
   and (s.id ~ ('(^|\D)' || a.num || '$') or s.name ~ ('#\s*0*' || a.num || '(\D|$)'))
   and s.address is distinct from a.addr;

-- What's left without a street address (Office Depot etc.). Send me this list.
select id, name, account, address
  from public.stores
 where active and (address is null or address !~ '^\d')
 order by account, name;
