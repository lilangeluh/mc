-- Mooncode: real accounts, friends, and private letters.
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
--
-- After this runs, letters can only be read and sent by signed-in users, so ship it
-- together with the app update that adds sign-up (the current name-only app stops working).

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
-- Messages: tie letters to accounts and make them private
-- ---------------------------------------------------------------

alter table public.messages
  add column if not exists sender_id uuid references public.profiles (id) on delete set null,
  add column if not exists recipient_id uuid references public.profiles (id) on delete set null,
  add column if not exists sender_seen_opened_at timestamptz;  -- replaces the per-browser "story seen" flag

create index if not exists messages_sender_id_idx on public.messages (sender_id);
create index if not exists messages_recipient_id_idx on public.messages (recipient_id);

-- Remove whatever policies exist today (they let anyone read every letter)
do $$
declare
  p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'messages' loop
    execute format('drop policy %I on public.messages', p.policyname);
  end loop;
end $$;

alter table public.messages enable row level security;

create policy "Read letters you sent or received"
  on public.messages for select to authenticated
  using (auth.uid() in (sender_id, recipient_id));

create policy "Send letters to friends"
  on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.are_friends(sender_id, recipient_id));

create policy "Open or acknowledge your letters"
  on public.messages for update to authenticated
  using (auth.uid() in (sender_id, recipient_id));

revoke all on public.messages from anon;
revoke update on public.messages from authenticated;
grant update (locked, receive_photo, receive_at, sender_seen_opened_at) on public.messages to authenticated;

-- Recipients may only open a letter; senders may only mark its opening as seen
create or replace function public.guard_message_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() = old.recipient_id then
    if new.sender_seen_opened_at is distinct from old.sender_seen_opened_at then
      raise exception 'Only the sender can acknowledge an opened letter';
    end if;
  elsif auth.uid() = old.sender_id then
    if new.locked is distinct from old.locked
      or new.receive_at is distinct from old.receive_at
      or new.receive_photo::text is distinct from old.receive_photo::text then
      raise exception 'Only the recipient can open a letter';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_message_update on public.messages;
create trigger guard_message_update
  before update on public.messages
  for each row execute function public.guard_message_update();

-- ---------------------------------------------------------------
-- Realtime: live letters and friend requests (row security still applies)
-- ---------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end $$;

-- ---------------------------------------------------------------
-- Optional, run later: attach old name-only letters to accounts once people have signed up
-- with the same display name. Letters with no match stay hidden.
-- ---------------------------------------------------------------
-- update public.messages m set sender_id = p.id
--   from public.profiles p where m.sender_id is null and m.sender = p.display_name;
-- update public.messages m set recipient_id = p.id
--   from public.profiles p where m.recipient_id is null and m.recipient = p.display_name;
