# WorkOS AuthKit setup

AntiClodeX uses one WorkOS environment for its web SPA, Electron desktop app,
and Fastify API.

## Dashboard configuration

1. Create or select an AuthKit environment and copy its client ID and secret API key.
2. Add `http://localhost:3000` and every deployed web origin as redirect URIs.
3. Add `http://localhost:3000/login` (and the deployed equivalent) as the Sign-in URL.
4. Add each web origin to the Authentication allowed-origins list.
5. Add `anticlodex://auth/callback` as a desktop redirect URI.
6. Configure default sign-out destinations for both web and desktop flows.
7. Enable the required social providers, such as Google or GitHub.

Copy each app's `.env.example` to `.env.local` and fill in the WorkOS values.
The API key belongs only in `apps/api/.env.local`; never expose it through a
`VITE_` variable or ship it in Electron.

## Import existing Auth0 identities

Use WorkOS's supported migration package so existing identities receive their
former Auth0 subject as `external_id`:

```bash
npx workos migrations export auth0 \
  --domain <auth0-domain> \
  --client-id <auth0-m2m-client-id> \
  --client-secret <auth0-m2m-client-secret> \
  --output-dir ./migration-auth0

npx workos migrations validate-package ./migration-auth0

WORKOS_SECRET_KEY=<workos-secret-key> \
  npx workos migrations import-package ./migration-auth0 --dry-run

WORKOS_SECRET_KEY=<workos-secret-key> \
  npx workos migrations import-package ./migration-auth0
```

Run database migrations before enabling WorkOS login:

```bash
pnpm migrate
```

Migration `003_workos_identity.sql` preserves the old Auth0 subjects in the
renamed `users.identity_subject` column. On an imported user's first WorkOS API
request, `apps/api/src/auth.ts` matches WorkOS `external_id`, updates that row to
the WorkOS subject, and keeps the existing AntiClodeX user ID, handle, projects,
and memberships.

Password users require an Auth0 password-hash export or a password reset. Review
the WorkOS Auth0 migration guide before switching production traffic.
