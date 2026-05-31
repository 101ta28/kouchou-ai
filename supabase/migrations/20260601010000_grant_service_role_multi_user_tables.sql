grant usage on schema public to service_role;

grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.organizations to service_role;
grant select, insert, update, delete on table public.organization_memberships to service_role;
grant select, insert, update, delete on table public.reports to service_role;
grant select, insert, update, delete on table public.report_permissions to service_role;
