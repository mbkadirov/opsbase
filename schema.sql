-- OpsBase Schema
-- Run this in Supabase SQL Editor

-- Drop existing tables if re-running
drop table if exists issues cascade;
drop table if exists stores cascade;

-- Stores table
create table stores (
  id text primary key,
  name text not null,
  account text not null,
  state text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz default now()
);

-- Issues table
create table issues (
  id bigserial primary key,
  store_id text references stores(id) on delete cascade,
  category text not null,
  date date not null default current_date,
  description text not null,
  status text not null default 'open',
  assignee text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes
create index issues_store_id_idx on issues(store_id);
create index issues_status_idx on issues(status);
create index issues_date_idx on issues(date desc);
create index stores_account_idx on stores(account);
create index stores_active_idx on stores(active);

-- RLS
alter table stores enable row level security;
alter table issues enable row level security;

create policy "Public read stores" on stores for select using (true);
create policy "Public insert stores" on stores for insert with check (true);
create policy "Public update stores" on stores for update using (true);
create policy "Public delete stores" on stores for delete using (true);

create policy "Public read issues" on issues for select using (true);
create policy "Public insert issues" on issues for insert with check (true);
create policy "Public update issues" on issues for update using (true);
create policy "Public delete issues" on issues for delete using (true);

-- ── SEED DATA ─────────────────────────────────────────────────────────

insert into stores (id, name, account, state, address, active) values

-- GIANT FOOD (43)
('GF-109',  'Giant Food #109',  'Giant Food', 'MD', 'Westminster, MD',       true),
('GF-132',  'Giant Food #132',  'Giant Food', 'MD', 'Bethesda, MD',          true),
('GF-144',  'Giant Food #144',  'Giant Food', 'MD', 'Baltimore, MD',         true),
('GF-146',  'Giant Food #146',  'Giant Food', 'MD', 'Prince Frederick, MD',  true),
('GF-159',  'Giant Food #159',  'Giant Food', 'MD', 'Pikesville, MD',        true),
('GF-304',  'Giant Food #304',  'Giant Food', 'MD', 'Waldorf, MD',           true),
('GF-337',  'Giant Food #337',  'Giant Food', 'MD', 'Baltimore, MD',         true),
('GF-364',  'Giant Food #364',  'Giant Food', 'MD', 'Bel Air, MD',           true),
('GF-2318', 'Giant Food #2318', 'Giant Food', 'MD', 'Owings Mills, MD',      true),
('GF-2333', 'Giant Food #2333', 'Giant Food', 'MD', 'Baltimore, MD',         true),
('GF-6004', 'Giant Food #6004', 'Giant Food', 'PA', 'Lititz, PA',            true),
('GF-6014', 'Giant Food #6014', 'Giant Food', 'PA', 'Elizabethtown, PA',     true),
('GF-6029', 'Giant Food #6029', 'Giant Food', 'PA', 'Centerville, PA',       true),
('GF-6050', 'Giant Food #6050', 'Giant Food', 'PA', 'Reading, PA',           true),
('GF-6051', 'Giant Food #6051', 'Giant Food', 'PA', 'Exton, PA',             true),
('GF-6079', 'Giant Food #6079', 'Giant Food', 'PA', 'York, PA',              true),
('GF-6088', 'Giant Food #6088', 'Giant Food', 'PA', 'Middletown, PA',        true),
('GF-6097', 'Giant Food #6097', 'Giant Food', 'PA', 'Hershey, PA',           true),
('GF-6098', 'Giant Food #6098', 'Giant Food', 'PA', 'Cleona, PA',            true),
('GF-6104', 'Giant Food #6104', 'Giant Food', 'MD', 'Hagerstown, MD',        true),
('GF-6106', 'Giant Food #6106', 'Giant Food', 'PA', 'New Hope, PA',          true),
('GF-6112', 'Giant Food #6112', 'Giant Food', 'PA', 'Carlisle, PA',          true),
('GF-6116', 'Giant Food #6116', 'Giant Food', 'PA', 'West Chester, PA',      true),
('GF-6117', 'Giant Food #6117', 'Giant Food', 'PA', 'Leola, PA',             true),
('GF-6123', 'Giant Food #6123', 'Giant Food', 'PA', 'Bethlehem, PA',         true),
('GF-6266', 'Giant Food #6266', 'Giant Food', 'PA', 'Lebanon, PA',           true),
('GF-6271', 'Giant Food #6271', 'Giant Food', 'PA', 'Shrewsbury, PA',        true),
('GF-6294', 'Giant Food #6294', 'Giant Food', 'PA', 'York, PA',              true),
('GF-6300', 'Giant Food #6300', 'Giant Food', 'PA', 'Red Lion, PA',          true),
('GF-6304', 'Giant Food #6304', 'Giant Food', 'PA', 'Harrisburg, PA',        true),
('GF-6306', 'Giant Food #6306', 'Giant Food', 'PA', 'Dover, PA',             true),
('GF-6307', 'Giant Food #6307', 'Giant Food', 'MD', 'Eldersburg, MD',        true),
('GF-6310', 'Giant Food #6310', 'Giant Food', 'PA', 'Dillsburg, PA',         true),
('GF-6422', 'Giant Food #6422', 'Giant Food', 'PA', 'Temple, PA',            true),
('GF-6457', 'Giant Food #6457', 'Giant Food', 'PA', 'Trexlertown, PA',       true),
('GF-6478', 'Giant Food #6478', 'Giant Food', 'PA', 'Exton, PA',             true),
('GF-6484', 'Giant Food #6484', 'Giant Food', 'PA', 'Lancaster, PA',         true),
('GF-6545', 'Giant Food #6545', 'Giant Food', 'PA', 'West Chester, PA',      true),
('GF-6563', 'Giant Food #6563', 'Giant Food', 'PA', 'Quarryville, PA',       true),
('GF-6564', 'Giant Food #6564', 'Giant Food', 'PA', 'Harrisburg, PA',        true),
('GF-6565', 'Giant Food #6565', 'Giant Food', 'PA', 'Lebanon, PA',           true),
('GF-6567', 'Giant Food #6567', 'Giant Food', 'PA', 'Quarryville, PA',       true),
('GF-6572', 'Giant Food #6572', 'Giant Food', 'PA', 'Doylestown, PA',        true),

-- WEGMANS (14)
('WM-14',  'Wegmans #14',  'Wegmans', 'MD', 'Hunt Valley, MD',      true),
('WM-45',  'Wegmans #45',  'Wegmans', 'PA', 'Mechanicsburg, PA',    true),
('WM-53',  'Wegmans #53',  'Wegmans', 'MD', 'Bel Air, MD',          true),
('WM-125', 'Wegmans #125', 'Wegmans', 'MD', 'Owings Mills, MD',     true),
('WM-104', 'Wegmans #104', 'Wegmans', 'PA', 'North Wales, PA',      true),
('WM-10',  'Wegmans #10',  'Wegmans', 'NJ', 'Cherry Hill, NJ',      true),
('WM-152', 'Wegmans #152', 'Wegmans', 'PA', 'Yardley, PA',          true),
('WM-8',   'Wegmans #8',   'Wegmans', 'NJ', 'Mount Laurel, NJ',     true),
('WM-36',  'Wegmans #36',  'Wegmans', 'PA', 'Warrington, PA',       true),
('WM-43',  'Wegmans #43',  'Wegmans', 'PA', 'Collegeville, PA',     true),
('WM-97',  'Wegmans #97',  'Wegmans', 'PA', 'Bethlehem, PA',        true),
('WM-135', 'Wegmans #135', 'Wegmans', 'PA', 'Lancaster, PA',        true),
('WM-79',  'Wegmans #79',  'Wegmans', 'PA', 'Allentown, PA',        true),
('WM-40',  'Wegmans #40',  'Wegmans', 'MD', 'Lanham, MD',           true),

-- FOOD LION (2)
('FL-1413', 'Food Lion #1413', 'Food Lion', 'MD', 'Perry Hall, MD', true),
('FL-2257', 'Food Lion #2257', 'Food Lion', 'WV', 'Inwood, WV',     true),

-- SOLIDCORE (12)
('SC-11', 'Solidcore #11', 'Solidcore', 'MD', '2558 Solomons Island Rd, Annapolis, MD',  true),
('SC-30', 'Solidcore #30', 'Solidcore', 'MD', '1405 Point St Suite 3, Baltimore, MD',    true),
('SC-97', 'Solidcore #97', 'Solidcore', 'MD', '101 W Cross Street Ste B, Baltimore, MD', true),
('SC-1',  'Solidcore #1',  'Solidcore', 'DC', '1706 Columbia Rd NW, Washington, DC',     true),
('SC-4',  'Solidcore #4',  'Solidcore', 'DC', '3308 Wisconsin Ave NW, Washington, DC',   true),
('SC-8',  'Solidcore #8',  'Solidcore', 'MD', '10245 Old Georgetown Rd, Bethesda, MD',   true),
('SC-9',  'Solidcore #9',  'Solidcore', 'MD', '7101 Wisconsin Ave, Bethesda, MD',        true),
('SC-16', 'Solidcore #16', 'Solidcore', 'DC', '1255 23rd St NW, Washington, DC',         true),
('SC-24', 'Solidcore #24', 'Solidcore', 'DC', '1245 First St SE, Washington, DC',        true),
('SC-50', 'Solidcore #50', 'Solidcore', 'DC', '1441 U Street NW, Washington, DC',        true),
('SC-67', 'Solidcore #67', 'Solidcore', 'DC', '931 H Street NW, Washington, DC',         true),
('SC-79', 'Solidcore #79', 'Solidcore', 'DC', '1024 6th Street NW, Washington, DC',      true),

-- ZARA (3)
('ZA-200', 'Zara #200', 'Zara', 'MD', 'Annapolis, MD', true),
('ZA-710', 'Zara #710', 'Zara', 'MD', 'Bethesda, MD',  true),
('ZA-825', 'Zara #825', 'Zara', 'MD', 'Towson, MD',    true),

-- OFFICE DEPOT (1)
('OD-950', 'Office Depot #950', 'Office Depot', 'PA', 'Newville, PA', true)

on conflict (id) do nothing;
