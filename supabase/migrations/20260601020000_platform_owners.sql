create table if not exists public.platform_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_owners enable row level security;

create policy "platform owners can read their own status"
  on public.platform_owners for select
  using (auth.uid() = user_id);

grant select, insert, update, delete on table public.platform_owners to service_role;
