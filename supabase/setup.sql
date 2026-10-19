-- POLVO · preparación de la base de datos en Supabase
-- Copiar todo, pegar en SQL Editor → New query, y tocar Run. Se puede correr más de una vez sin problema.

-- Documentos del juego, guardados por ruta: catalog/<id>, catalog/<id>/parts/p0, tracks/<id>, bodies/<id>, data/users/<uid>/...
create table if not exists public.docs (
  path text primary key check (path ~ '^[A-Za-z0-9_.:@+~-]+(/[A-Za-z0-9_.:@+~-]+)+$'),
  coll text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  data jsonb not null,
  owner uuid not null default auth.uid(),
  updated_at timestamptz not null default now()
);
create index if not exists docs_coll_idx on public.docs (coll);
alter table public.docs replica identity full;

-- el dueño del juego: el único que publica autos en el catálogo
create or replace function public.polvo_admin() returns boolean
language sql stable as $$
  select coalesce(lower(auth.jwt() ->> 'email'), '') = 'manu.galdeano@gmail.com'
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

-- fecha de modificación automática
create or replace function public.polvo_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.polvo_touch();

alter table public.docs enable row level security;

drop policy if exists docs_read on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

-- leer: todo lo compartido; los datos personales solo su dueño
create policy docs_read on public.docs for select to authenticated using (
  path not like 'data/users/%' or path like 'data/users/' || auth.uid()::text || '/%'
);
-- crear: catálogo solo el dueño del juego; pistas y autos pintados cualquiera; datos personales solo los propios
create policy docs_insert on public.docs for insert to authenticated with check (
  owner = auth.uid() and (
    (path like 'catalog/%' and public.polvo_admin())
    or path like 'tracks/%'
    or path like 'bodies/%'
    or path like 'data/users/' || auth.uid()::text || '/%'
  )
);
-- modificar y borrar: el catálogo el dueño del juego; lo demás, quien lo creó
create policy docs_update on public.docs for update to authenticated
  using ((path like 'catalog/%' and public.polvo_admin()) or (path not like 'catalog/%' and owner = auth.uid()))
  with check ((path like 'catalog/%' and public.polvo_admin()) or (path not like 'catalog/%' and owner = auth.uid()));
create policy docs_delete on public.docs for delete to authenticated
  using ((path like 'catalog/%' and public.polvo_admin()) or (path not like 'catalog/%' and owner = auth.uid()));

-- avisos en vivo cuando cambian el catálogo o las pistas
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
