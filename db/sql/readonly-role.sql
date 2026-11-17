-- Creates (or updates) the read-only login the Saada Hisaab MCP server uses.
-- Run by db/setup-db.ps1 with psql variables: ro_user, ro_pw, db_name.
-- Safe to re-run.

-- 1. Create the role if it is missing, then (re)set its password and limits.
SELECT format('CREATE ROLE %I LOGIN', :'ro_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'ro_user') \gexec
-- (A new role is already NOSUPERUSER/NOCREATEDB/NOCREATEROLE; naming those here fails on Supabase,
--  where the admin user is not a superuser.)
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'ro_user', :'ro_pw') \gexec

-- 2. Every session of this role is read-only and cannot run long queries.
SELECT format('ALTER ROLE %I IN DATABASE %I SET default_transaction_read_only = on', :'ro_user', :'db_name') \gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L', :'ro_user', :'db_name', '15s') \gexec

-- 3. Read access to all application tables.
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'ro_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'ro_user') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'ro_user') \gexec

-- 4. Take back what ChatGPT must never see:
--    - internal logs and migration history (whole tables)
--    - "User" and "Tenant" secrets (password hash, push token, FBR API / terminal tokens)
SELECT format('REVOKE ALL ON public."FbrApiLogs", public."SuperadminLog", public."_prisma_migrations" FROM %I', :'ro_user') \gexec
SELECT format('REVOKE ALL ON public."User", public."Tenant" FROM %I', :'ro_user') \gexec

SELECT format(
  'GRANT SELECT (id, username, "fullName", role, "tenantId", "branchId", "isDeleted", "isEnabled", "createdAt") ON public."User" TO %I',
  :'ro_user') \gexec

SELECT format(
  'GRANT SELECT (id, "businessName", address, province, phone, cell, ntn, "ntnCnic", "salesTaxNo", "industryId",'
  ' "isEnabled", "isMultiBranch", "isTrackExpiry", "isHrmEnabled", "isReportingDisabled", "createdAt") ON public."Tenant" TO %I',
  :'ro_user') \gexec

-- 5. Supabase only (no-op elsewhere): Supabase's automatic Data API serves the public schema to its
--    "anon" and "authenticated" roles. Remove their access so the data is reachable only through this app.
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', rolname)
  FROM pg_roles WHERE rolname IN ('anon', 'authenticated') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', rolname)
  FROM pg_roles WHERE rolname IN ('anon', 'authenticated') \gexec
