-- Replace the provider-specific Auth0 subject column with a neutral identity subject.
-- Existing values are preserved so the WorkOS external_id migration can rebind them
-- to WorkOS user subjects on first authenticated API access.

alter table users rename column auth0_id to identity_subject;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'users_auth0_id_key'
      and conrelid = 'users'::regclass
  ) then
    alter table users rename constraint users_auth0_id_key to users_identity_subject_key;
  end if;
end
$$;
