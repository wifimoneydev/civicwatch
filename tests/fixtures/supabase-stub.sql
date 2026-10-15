-- Minimal local stand-in for the Supabase objects our migration depends on,
-- so policies can be exercised in PGlite. Function bodies mirror Supabase's
-- definitions of auth.uid(), storage.foldername() and storage.extension().
-- NOT a full Supabase emulation: the Storage API's file size / MIME checks
-- and the Realtime server are not reproduced here.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase's default privileges: new public tables are fully granted.
alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (id uuid primary key, email text);

create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
$$;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
    id                 text primary key,
    name               text not null unique,
    public             boolean default false,
    file_size_limit    bigint,
    allowed_mime_types text[]
);

create table storage.objects (
    id        uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name      text,
    owner     uuid default auth.uid(),
    unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
    select string_to_array(name, '/') into _parts;
    return _parts[1:array_length(_parts, 1) - 1];
end
$$;

create function storage.extension(name text) returns text language plpgsql as $$
declare _parts text[]; _filename text;
begin
    select string_to_array(name, '/') into _parts;
    select _parts[array_length(_parts, 1)] into _filename;
    return reverse(split_part(reverse(_filename), '.', 1));
end
$$;

create publication supabase_realtime;
