create table if not exists public.app_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{"quotes":[],"clients":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_data enable row level security;

drop policy if exists "app_data_select_own" on public.app_data;
drop policy if exists "app_data_insert_own" on public.app_data;
drop policy if exists "app_data_update_own" on public.app_data;
drop policy if exists "app_data_delete_own" on public.app_data;

create policy "app_data_select_own"
on public.app_data
for select
to authenticated
using (auth.uid() = user_id);

create policy "app_data_insert_own"
on public.app_data
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "app_data_update_own"
on public.app_data
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "app_data_delete_own"
on public.app_data
for delete
to authenticated
using (auth.uid() = user_id);

grant select, insert, update, delete on public.app_data to authenticated;
