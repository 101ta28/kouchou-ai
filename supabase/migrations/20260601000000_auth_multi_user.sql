create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'creator', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  title text not null,
  status text not null check (status in ('processing', 'ready', 'error', 'deleted')),
  visibility text not null default 'private' check (visibility in ('private', 'unlisted', 'public')),
  artifact_path text,
  retention_expires_at timestamptz not null,
  purged_at timestamptz,
  purge_status text not null default 'active' check (purge_status in ('active', 'pending', 'purged', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_permissions (
  report_id uuid not null references public.reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  permission text not null check (permission in ('view', 'edit')),
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

create index if not exists organization_memberships_user_id_idx
  on public.organization_memberships(user_id);

create index if not exists reports_organization_id_idx
  on public.reports(organization_id);

create index if not exists reports_retention_purge_idx
  on public.reports(retention_expires_at, purge_status);

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.reports enable row level security;
alter table public.report_permissions enable row level security;

create policy "profiles are visible to the owning user"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "members can read their organizations"
  on public.organizations for select
  using (
    exists (
      select 1
      from public.organization_memberships memberships
      where memberships.organization_id = organizations.id
        and memberships.user_id = auth.uid()
    )
  );

create policy "members can read memberships in their organizations"
  on public.organization_memberships for select
  using (
    exists (
      select 1
      from public.organization_memberships own_membership
      where own_membership.organization_id = organization_memberships.organization_id
        and own_membership.user_id = auth.uid()
    )
  );

create policy "members can read reports in their organizations"
  on public.reports for select
  using (
    purge_status <> 'purged'
    and retention_expires_at > now()
    and exists (
      select 1
      from public.organization_memberships memberships
      where memberships.organization_id = reports.organization_id
        and memberships.user_id = auth.uid()
    )
  );

create policy "users can read their report permissions"
  on public.report_permissions for select
  using (auth.uid() = user_id);
