-- CivicWatch: checkpoint 1 database setup
-- Run the whole file in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run: every statement is idempotent.
--
-- Creates:
--   * public.incidents table (validated, indexed, row level security)
--   * incident-photos storage bucket (5 MB, JPEG/PNG/WebP) + upload policies
--   * Realtime publication for new incidents

-- ---------------------------------------------------------------------------
-- 1. Incidents table
-- ---------------------------------------------------------------------------

create table if not exists public.incidents (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null default auth.uid()
                        references auth.users (id) on delete cascade,
    title               text not null,
    description         text not null,
    category            text not null,
    latitude            double precision not null,
    longitude           double precision not null,
    location_source     text not null default 'gps',
    photo_path          text,
    verification_status text not null default 'unverified',
    created_at          timestamptz not null default now(),

    constraint incidents_title_length
        check (char_length(btrim(title)) between 3 and 120),
    constraint incidents_description_length
        check (char_length(btrim(description)) between 10 and 2000),
    constraint incidents_category_valid
        check (category in ('accident', 'fighting', 'rioting', 'fire', 'theft', 'other')),
    constraint incidents_latitude_range
        check (latitude between -90 and 90),
    constraint incidents_longitude_range
        check (longitude between -180 and 180),
    constraint incidents_location_source_valid
        check (location_source in ('gps', 'manual')),
    -- Photos must live in the submitter's own folder: "<user_id>/<name>.<ext>"
    constraint incidents_photo_path_owned
        check (photo_path is null
               or photo_path ~ ('^' || user_id::text || '/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$')),
    constraint incidents_verification_status_valid
        check (verification_status in ('unverified', 'verified', 'rejected'))
);

comment on table public.incidents is
    'Citizen incident reports. Published on insert; unverified until reviewed by an administrator.';
comment on column public.incidents.verification_status is
    'Set only by administrators (dashboard / service role). App users cannot write this column.';

create index if not exists incidents_created_at_idx
    on public.incidents (created_at desc);
create index if not exists incidents_category_created_at_idx
    on public.incidents (category, created_at desc);
create index if not exists incidents_user_id_created_at_idx
    on public.incidents (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Table privileges
--    Supabase grants ALL on new public tables to anon/authenticated by default.
--    Replace that with the minimum the app needs.
-- ---------------------------------------------------------------------------

revoke all on table public.incidents from anon, authenticated;

-- Signed-in users: read, delete (own rows only, via RLS), and insert ONLY
-- these columns. id, created_at and verification_status are not insertable,
-- so clients cannot back-date reports or mark them verified.
-- No UPDATE grant: reports cannot be edited from the app at all.
grant select, delete on table public.incidents to authenticated;
grant insert (user_id, title, description, category, latitude, longitude,
              location_source, photo_path)
    on table public.incidents to authenticated;

-- Anonymous (signed-out) requests may run SELECT, but no RLS policy exists for
-- the anon role, so they always receive zero rows. This lets a signed-out
-- connection check succeed without exposing any report.
grant select on table public.incidents to anon;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.incidents enable row level security;

drop policy if exists "Signed-in users can browse incidents" on public.incidents;
create policy "Signed-in users can browse incidents"
    on public.incidents for select
    to authenticated
    using (true);

drop policy if exists "Users can submit their own incidents" on public.incidents;
create policy "Users can submit their own incidents"
    on public.incidents for insert
    to authenticated
    with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete their own incidents" on public.incidents;
create policy "Users can delete their own incidents"
    on public.incidents for delete
    to authenticated
    using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. Storage bucket for incident photos
--    Public bucket: anyone with an object's URL can view it (needed for <img>
--    tags without per-image signed URLs). Uploads are still restricted by the
--    policies below, objects cannot be listed, and paths contain a random id.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('incident-photos', 'incident-photos', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload incident photos to their own folder" on storage.objects;
create policy "Users can upload incident photos to their own folder"
    on storage.objects for insert
    to authenticated
    with check (
        bucket_id = 'incident-photos'
        and array_length(storage.foldername(name), 1) = 1
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
    );

-- Owners may see and delete their own objects (needed to remove a photo if the
-- report insert fails). Nobody else can list the bucket.
drop policy if exists "Users can read their own incident photo objects" on storage.objects;
create policy "Users can read their own incident photo objects"
    on storage.objects for select
    to authenticated
    using (
        bucket_id = 'incident-photos'
        and (storage.foldername(name))[1] = (select auth.uid()::text)
    );

drop policy if exists "Users can delete their own incident photos" on storage.objects;
create policy "Users can delete their own incident photos"
    on storage.objects for delete
    to authenticated
    using (
        bucket_id = 'incident-photos'
        and (storage.foldername(name))[1] = (select auth.uid()::text)
    );

-- ---------------------------------------------------------------------------
-- 5. Realtime: broadcast new incidents to subscribed clients.
--    Realtime applies the SELECT policy above, so only signed-in users
--    receive incident events.
-- ---------------------------------------------------------------------------

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'incidents'
    ) then
        alter publication supabase_realtime add table public.incidents;
    end if;
end
$$;
