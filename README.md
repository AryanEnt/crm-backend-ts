# backend-ts

TypeScript + Express rewrite of the Go CRM API (`../backend`), ported module by module.
Responses, error codes, cookies and JWTs are identical to Go, so the frontend can talk
to either backend and sessions carry over.

Every Go route is ported. During the switch-over, unknown routes can still be forwarded to
the Go backend (`GO_BACKEND_URL`); leave it empty to run standalone. The switch-over steps
are in [RAILWAY.md](RAILWAY.md#switch-over).

## Status

| Area                          | Status                     |
| ----------------------------- | -------------------------- |
| Health (`/api/health`, `/api/v1/health`) | Ported          |
| Auth (`/api/v1/auth/*`)       | Ported                     |
| Audit logs, system activity   | Ported                     |
| Lead sources, settings, ANZSCO | Ported                    |
| Custom fields (definitions and record values) | Ported     |
| Pipelines and stages          | Ported                     |
| Permissions / data scope helpers | Ported                  |
| Leads (list, duplicates, bulk, qualify), referrals | Ported |
| Customers (+ lead conversion, profile) | Ported            |
| Deals (list, board, move, documents) | Ported              |
| Activities, activity types, `me/timezone` | Ported         |
| Documents (request, upload, download, verify/reject) | Ported |
| Referrals (list, summary, referrer profiles, partners) | Ported |
| Timeline (list, types, external events) | Ported           |
| Analytics (funnel, summary, breakdowns, organization) | Ported |
| Targets (metrics, progress, CRUD)       | Ported           |
| Forecasting (methodology, pipeline)     | Ported           |
| Predictions (catalog, workload, pipeline risk, lead/deal insights) | Ported |
| Automations (catalog, rules, runs, jobs, retry) | Ported   |
| Automation worker             | Ported, off by default while Go runs (see below) |
| Calls workspace (contacts, context, history, notes) | Ported |
| Communications (accounts, WhatsApp, Twilio, provider webhooks) | Ported |
| Email (Gmail OAuth, accounts, threads, compose/send, templates, Pub/Sub) | Ported |
| Email worker (watch renewal, scheduled send) | Ported, off by default while Go runs (see below) |
| Users, teams, roles           | Ported                     |

The automation and email workers are controlled by `AUTOMATION_WORKER` and `EMAIL_WORKER`
(`true`/`false`). Both default to on only when `GO_BACKEND_URL` is empty, so Go's workers stay
the only ones while both backends run. At switch-over, stop Go and either unset
`GO_BACKEND_URL` or set both flags to `true`.

While both backends run, `TOKEN_ENCRYPTION_KEY` (or `JWT_SECRET`, its fallback) must match
Go's so either backend can decrypt the Gmail tokens the other stored. Google OAuth and Twilio
callbacks are built from `PUBLIC_API_URL`; it must be the URL registered with Google and
reachable by Twilio, i.e. whichever backend receives that traffic.

Uploaded files go to the local filesystem under `STORAGE_ROOT`. Locally, point it at Go's
directory (`../backend/storage`) so files uploaded through either backend can be downloaded
from both. Railway volumes attach to a single service, so there the files are copied over
at switch-over.

## Stack

Node 22+, Express 5, Kysely + pg, zod, jsonwebtoken, bcryptjs, pino, Vitest.

## Local development

```sh
cp .env.example .env      # use the same JWT_SECRET as backend/.env
npm install
npm run dev               # http://localhost:8081, Go stays on 8080
```

| Script              | Purpose                                                 |
| ------------------- | ------------------------------------------------------- |
| `npm run dev`       | Watch mode with `.env`                                  |
| `npm run build`     | Compile to `dist/`                                      |
| `npm start`         | Run the compiled server                                 |
| `npm run migrate`   | Apply pending migrations (`migrate:dev` runs from source) |
| `npm run seed`      | Create the first Super Admin if there are no users (`seed:dev`) |
| `npm run db:types`  | Regenerate `src/db/schema.ts` from the database         |
| `npm test`          | Unit and HTTP tests (no database needed)                |
| `npm run typecheck` | Type-check source and tests                             |

## Layout

```
src/
  app.ts, index.ts, config.ts, logger.ts
  cli/            migrate and seed entry points
  db/             pool, Kysely instance, generated schema, migration runner, seed
  lib/            AppError, response envelope, JSON validation
  middleware/     request id, logging, CORS, errors, Go proxy
  modules/        one folder per Go package (auth, pipelines, custom-fields, ...)
migrations/       copy of backend/internal/database/migrations
test/
```

## Porting a module

1. Read the Go package under `backend/internal/<module>`.
2. Add `src/modules/<module>/` with a service (Kysely) and routes built with `createRouter()`,
   `guard(...perms)` for Go's `protect`, and `inScope(...)` for record checks.
3. Mirror Go's JSON exactly: struct field order, `null` for nil slices, omitted `omitempty`
   fields, sorted keys for anything Go holds in a map (`goSortKeys`), and the request body
   helpers in `lib/validate.ts` for Go's decoding rules.
4. Mount the router in `src/app.ts` before the Go proxy. Mounted routes stop being forwarded.
5. Port the Go tests and compare live responses with Go before switching traffic.

Deployment: see [RAILWAY.md](RAILWAY.md).
