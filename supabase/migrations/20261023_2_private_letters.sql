-- Mooncode, part 2 of 2: make letters private to their sender and recipient.
-- Run this at switch-over, together with deploying the account-based app.
-- After it runs, the old name-only app can no longer read or send letters.

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
