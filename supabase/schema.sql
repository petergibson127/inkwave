-- Inkwave Supabase schema. Run this in your fresh Supabase project (SQL editor).
--
-- Clerk owns authentication; this table is our own minimal mirror of the user — the email we may
-- need "later down the track" plus the paid-subscription flag M6 gates on. It holds NO content;
-- the writing never touches Supabase (that's the zero-retention promise). Kept deliberately small.

create table if not exists public.profiles (
  clerk_user_id       text primary key,
  email               text,
  subscription_active boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Only our server-side /api functions (Supabase service-role key) touch this table. RLS on with no
-- policies means the anon/public client cannot read or write it; the service role bypasses RLS.
alter table public.profiles enable row level security;

-- keep updated_at fresh on writes
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();
