-- Draft Day cloud sync — run this once in the Supabase SQL Editor
-- (Project → SQL Editor → New query → paste → Run).

create table if not exists app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  draft_state jsonb,
  notes text default '',
  updated_at timestamptz not null default now()
);

alter table app_state enable row level security;

-- Each policy is scoped to auth.uid() = user_id, so a signed-in user can only
-- ever touch their own row — enforced by Postgres itself, not app code.
create policy "select own row" on app_state
  for select using (auth.uid() = user_id);

create policy "insert own row" on app_state
  for insert with check (auth.uid() = user_id);

create policy "update own row" on app_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "delete own row" on app_state
  for delete using (auth.uid() = user_id);
