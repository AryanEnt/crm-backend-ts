# Deploying backend-ts on Railway

The TypeScript API serves every route the Go backend has. It runs as its own Railway
service; during the switch-over it can still forward unknown routes to Go
(`GO_BACKEND_URL`), so the frontend only ever needs this one URL.

## Service setup

1. In the Railway project, **New → GitHub Repo** (same repo as the Go service).
2. **Settings → Source → Root Directory:** `backend-ts`
3. **Settings → Config-as-code → Railway config file:** `/backend-ts/railway.json`
   (the path is absolute; it does not follow the root directory).

`railway.json` sets:

| Setting            | Value                       |
| ------------------ | --------------------------- |
| Builder            | `Dockerfile`                |
| Pre-deploy command | `node dist/cli/migrate.js`  |
| Start command      | `node dist/index.js`        |
| Health check path  | `/api/v1/health`            |

If you prefer the dashboard, set the same values under **Settings → Deploy**.

## Variables

Reference the existing Postgres and Go services instead of copying values.

| Variable                   | Value                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`             | `${{Postgres.DATABASE_URL}}`                                       |
| `JWT_SECRET`               | `${{<go-service>.JWT_SECRET}}` — must be identical to Go's         |
| `TOKEN_ENCRYPTION_KEY`     | `${{<go-service>.TOKEN_ENCRYPTION_KEY}}` (if Go sets it)           |
| `APP_ENV`                  | `production`                                                       |
| `FRONTEND_URL`             | Frontend origin(s), comma-separated                                |
| `PUBLIC_API_URL`           | This service's public URL, e.g. `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `GO_BACKEND_URL`           | Switch-over only: `http://${{<go-service>.RAILWAY_PRIVATE_DOMAIN}}:${{<go-service>.PORT}}` |
| `STORAGE_ROOT`             | `/data/storage` when this service has a volume mounted at `/data`; otherwise `/app/storage` |
| `RAILWAY_RUN_UID`          | `0` when using a Railway volume with this image                     |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GMAIL_PUBSUB_TOPIC` | Same as Go, when used |

`PORT` is injected by Railway; do not set it.

Do not point `STORAGE_ROOT` at a sibling service's directory (for example
`../backend/storage`). Each Railway service has its own filesystem. For persistent
uploads, mount a volume on the TS service at `/data` and set `STORAGE_ROOT=/data/storage`.
Railway mounts volumes as `root`, while this image runs as `node`; set
`RAILWAY_RUN_UID=0` on the TS service so it can create and write `/data/storage`.
Without a volume, use `/app/storage` (writable by the container's `node` user, but
ephemeral across redeploys).

`JWT_SECRET` must match so sessions carry over, and `TOKEN_ENCRYPTION_KEY` (or
`JWT_SECRET`, its fallback) must match so the Gmail tokens Go stored can be decrypted.

`AUTOMATION_WORKER` and `EMAIL_WORKER` default to on only when `GO_BACKEND_URL` is empty,
so the background workers never run in both services at once by accident.

## Migrations

- The pre-deploy command applies pending `*.up.sql` files and records them in
  `schema_migrations`, the same table and versions the Go backend uses. Already-applied
  migrations are skipped, so running it on every deploy is safe.
- Down migrations are never run. Nothing is dropped or reset.
- The API process itself never migrates.
- `migrations/` is a copy of `backend/internal/database/migrations`; `npm test` fails
  if the two diverge. Add new migrations to both until Go is retired.

## Bootstrap admin (one-off)

The seed only creates the first Super Admin when the `users` table is empty, and does
nothing otherwise. It is never run automatically.

```sh
railway run --service <ts-service> node dist/cli/seed.js
```

With `APP_ENV=production` it requires `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` (12+ characters). Set them as service variables for the run,
then remove them. An existing production database already has users, so this is only
needed for a fresh environment.

## Switch-over

Do these in order. Until step 6, rolling back is only a frontend variable change.

1. **Deploy TS next to Go** with `GO_BACKEND_URL` set and the worker flags unset, and wait
   for `GET /api/v1/health` to return `"status":"ok"`.
2. **Point the frontend at TS:** set its `API_INTERNAL_URL` and `NEXT_PUBLIC_API_BASE_URL`
   to the TS service URL and redeploy it. Signed-in users stay signed in.
3. **Move provider callbacks to the TS domain** (`PUBLIC_API_URL` must be that domain):
   - Google Cloud OAuth client: add `https://<ts-domain>/api/v1/email/google/callback`
     as an authorized redirect URI.
   - Enable the Gmail API in the same Google Cloud project as that OAuth client. The
     backend requests Gmail read/send and Google user-info scopes during consent.
   - Gmail Pub/Sub push subscription: `https://<ts-domain>/api/v1/webhooks/google/pubsub`.
   - Meta WhatsApp webhook: `https://<ts-domain>/api/v1/webhooks/meta/whatsapp`
     (the verify token is stored with the account in the database, so it is unchanged).
   - Twilio needs no change: each call's status callback is built from `PUBLIC_API_URL`.
     Calls placed through Go before the switch still report to Go's URL, so keep Go up
     until they finish.
4. **Copy uploaded files.** Railway volumes attach to one service, so copy the contents
   of Go's storage volume into the TS volume at `STORAGE_ROOT` (same relative paths).
   Documents uploaded before this step can't be downloaded through TS until it's done.
5. **Check the app** through the frontend: sign in, open leads, deals, documents,
   email and the admin user/team screens.
6. **Move the background workers.** Stop the Go service first (remove its deployment or
   scale it to zero), then delete `GO_BACKEND_URL` from the TS service. Its next deploy
   logs `"automation_worker":true,"email_worker":true`. Jobs queued in between wait in
   the database and are picked up then.

Afterwards the Go service can be deleted once you no longer want it for rollback.

## Rollback

- Before step 6: point the frontend variables back at the Go service URL.
- After step 6: on TS set `AUTOMATION_WORKER=false` and `EMAIL_WORKER=false` first, then
  start Go again, then point the frontend (and any callbacks you moved) back at Go.

Both backends use the same schema, sessions and token encryption, so no data changes
are needed either way.
