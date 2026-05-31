create table if not exists public.organization_metadata (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  reporter text,
  message text,
  web_link text,
  privacy_link text,
  terms_link text,
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organization_metadata enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'organization_metadata'
      and policyname = 'members can read organization metadata'
  ) then
    create policy "members can read organization metadata"
      on public.organization_metadata for select
      using (
        exists (
          select 1
          from public.organization_memberships memberships
          where memberships.organization_id = organization_metadata.organization_id
            and memberships.user_id = auth.uid()
        )
      );
  end if;
end $$;

grant select, insert, update, delete on table public.organization_metadata to service_role;
