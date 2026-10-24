-- Mooncode, part 1 of 2: accounts, friends and cities.
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
-- Purely additive: the current name-only app keeps working after this.

-- ---------------------------------------------------------------
-- Profiles: public identity other users can search for
-- ---------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Signed-in users can look up profiles" on public.profiles;
create policy "Signed-in users can look up profiles"
  on public.profiles for select to authenticated
  using (true);

drop policy if exists "Users create their own profile" on public.profiles;
create policy "Users create their own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists "Users edit their own profile" on public.profiles;
create policy "Users edit their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------
-- Friendships: one row per pair, pending until the other person accepts
-- ---------------------------------------------------------------

create table if not exists public.friendships (
  id bigint generated always as identity primary key,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  check (requester_id <> addressee_id)
);

create unique index if not exists friendships_one_per_pair
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

alter table public.friendships enable row level security;

drop policy if exists "See your own friendships" on public.friendships;
create policy "See your own friendships"
  on public.friendships for select to authenticated
  using (auth.uid() in (requester_id, addressee_id));

drop policy if exists "Send a friend request" on public.friendships;
create policy "Send a friend request"
  on public.friendships for insert to authenticated
  with check (requester_id = auth.uid() and status = 'pending');

drop policy if exists "Accept a request sent to you" on public.friendships;
create policy "Accept a request sent to you"
  on public.friendships for update to authenticated
  using (addressee_id = auth.uid() and status = 'pending')
  with check (addressee_id = auth.uid() and status = 'accepted');

drop policy if exists "Decline, cancel or unfriend" on public.friendships;
create policy "Decline, cancel or unfriend"
  on public.friendships for delete to authenticated
  using (auth.uid() in (requester_id, addressee_id));

revoke update on public.friendships from anon, authenticated;
grant update (status, accepted_at) on public.friendships to authenticated;

create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = a and f.addressee_id = b) or (f.requester_id = b and f.addressee_id = a))
  );
$$;

revoke execute on function public.are_friends(uuid, uuid) from public, anon;
grant execute on function public.are_friends(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------
-- Locations: city-level only, visible to yourself and (if shared) accepted friends
-- ---------------------------------------------------------------

create table if not exists public.profile_locations (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  city text not null,
  timezone text,
  lat double precision,  -- the city's centre from the geocoder, never raw GPS
  lon double precision,
  share_with_friends boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.profile_locations enable row level security;

drop policy if exists "See your own and friends' cities" on public.profile_locations;
create policy "See your own and friends' cities"
  on public.profile_locations for select to authenticated
  using (
    profile_id = auth.uid()
    or (share_with_friends and public.are_friends(auth.uid(), profile_id))
  );

drop policy if exists "Set your own city" on public.profile_locations;
create policy "Set your own city"
  on public.profile_locations for insert to authenticated
  with check (profile_id = auth.uid());

drop policy if exists "Update your own city" on public.profile_locations;
create policy "Update your own city"
  on public.profile_locations for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ---------------------------------------------------------------
-- Messages: link letters to accounts (made private in part 2)
-- ---------------------------------------------------------------

alter table public.messages
  add column if not exists sender_id uuid references public.profiles (id) on delete set null,
  add column if not exists recipient_id uuid references public.profiles (id) on delete set null,
  add column if not exists sender_seen_opened_at timestamptz;  -- replaces the per-browser "story seen" flag

create index if not exists messages_sender_id_idx on public.messages (sender_id);
create index if not exists messages_recipient_id_idx on public.messages (recipient_id);

-- ---------------------------------------------------------------
-- Realtime: live friend requests
-- ---------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end $$;
