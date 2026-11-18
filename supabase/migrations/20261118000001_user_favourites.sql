-- Phase 1 proposal. Apply through the grocery backend's migration workflow.
-- Favourite rows are private to the authenticated Supabase user.
create table public.user_favourites (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

alter table public.user_favourites enable row level security;
revoke all on public.user_favourites from anon, authenticated;
grant select, insert, delete on public.user_favourites to authenticated;

create policy "Users can view their own favourites"
  on public.user_favourites for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can add their own favourites"
  on public.user_favourites for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users can remove their own favourites"
  on public.user_favourites for delete to authenticated
  using ((select auth.uid()) = user_id);

create index user_favourites_product_id_idx on public.user_favourites (product_id);
