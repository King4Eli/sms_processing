# SMS Processing API

Base URL: `/api/v1`. Implementation: `api/src/userApi.js`,
`api/src/workerApi.js`, `api/src/adminApi.js`.

## Auth

| Audience | Header | Table |
|---|---|---|
| Customer | `X-Api-Key: <key>` | `api_keys` |
| Worker | `Authorization: Bearer <token>` | `worker_tokens` |
| Admin | `X-Admin-Token: <token>` | none — static secret, `.env/admin.env` |

Separate credential spaces — one type never authenticates another's
routes. Workers are never self-service: a customer can select an
available number as `from`, but only an admin can create, list, or
revoke a worker. See [`admin-api.md`](./admin-api.md).

## `POST /users/token`

Open, no auth, no rate limit. Body: `{ email, phone, label? }`.

- `email` — required, validated (HTML5-spec pattern).
- `phone` — required, international format (`+` + country code). Validated
  with `libphonenumber-js`, normalized to E.164, `country` (ISO 3166-1
  alpha-2) derived from it.
- Existing email → updates `phone_number`/`country` on that user, doesn't duplicate.

`201`: `{ id, userId, email, phone, country, label, apiKey }` (`apiKey` shown once).

## `GET /numbers`

Auth: customer. Lists `worker_tokens.phone_number` where `revoked_at IS
NULL AND (is_public = 1 OR user_id = <caller>)` — every shared public
number, plus any private worker an admin has assigned to this caller
specifically. Someone else's private worker never appears here.

`200`: `["+15551234567", ...]`

## `POST /sms`

Auth: customer. Body: `{ to, from, message }`.

- `to` / `from` — both validated/normalized like `phone` in `/users/token`.
- `from` must match an active worker number the caller may use (same set
  as `GET /numbers`: public, or owned by the caller) — otherwise `400`.
  That worker becomes the *only* one that can ever pull or complete this
  message (see `/worker/sms/pull` below).

Rate limit: `api_keys.daily_sms_limit` (default `10`) per rolling 24h,
counted from `sms_queue` directly — see Rate limiting below. `429` if exceeded.

`201`: `{ id, to, from, message, status: 0 }`

## `POST /worker/sms/pull`

Auth: worker. Body: `{ count? }` — integer, `1`–`100`, default `1`.
Non-integers (`2.5`, `"3"`, negative, `0`, `>100`) → `400`.

Atomically claims up to `count` oldest `status=0` rows **submitted against
this worker's own number** (`WHERE worker_token_id = <caller's id>`) —
a worker never sees messages sent `from` a different number, public or
not. `0 -> 2` on each claim. Always `200` with a JSON array (possibly
empty) of `{ id, to, message, status }`. Full detail incl. concurrency
guarantee: [`worker-api.md`](./worker-api.md).

## `PATCH /worker/sms/:id/status`

Auth: worker. Requires the row currently be `status=2` **and** belong to
the calling worker's own number — `403` if it was submitted `from` a
different worker's number, even with an otherwise-valid worker token.

- `{ "status": 1 }` → `2 -> 1`, done.
- `{ "status": 0, "error_message": "..." }` → `2 -> 0`, re-queued.

`200` / `400` (bad body) / `403` (not your number) / `404` (no such id) /
`409` (not currently claimed).

## `sms_queue` field triggers

| Field | Set when |
|---|---|
| `pulled_at` | every pull, including re-pulls after a reported failure |
| `attempts` | `+1` on every pull — a message failed and re-pulled N times has `attempts = N` |
| `error_message` | set by a `status:0` report; **not** cleared by a later success — it's last-failure history |
| `processed_at` | only on `status:1` (final) |

## Rate limiting

Only `/sms` is limited, by `api_keys.daily_sms_limit` — read fresh per
request, not a code constant. Change it live:

```sql
UPDATE api_keys SET daily_sms_limit = ? WHERE id = ?;
```

Nothing else (`/worker/*`, `/users/token`, `/numbers`) is rate limited.

## Credentials

| Type | How | Auth |
|---|---|---|
| API key | `POST /users/token` | none — self-service |
| Worker token | `POST /admin/workers` | admin — `X-Admin-Token` |
| Worker token (alternate) | `docker compose exec api node scripts/create-worker-token.js "<name>" "<phone>" [--public]` | requires container exec access, not HTTP |

Both worker-token paths produce the same thing; the HTTP route is just
the CLI script without needing container exec. A customer can never
create, list, or revoke a worker themselves — see
[`admin-api.md`](./admin-api.md). A worker token only ever pulls/completes
SMS submitted against its own number (`worker_token_id` scoping in
`workerApi.js`), regardless of which path created it. See
[`worker-api.md`](./worker-api.md) for the CLI script's full usage
(`--public`/`-p`, `-h`/`--help`). Both credential types are shown once;
only their SHA-256 hash is stored (`api_keys.key_hash` /
`worker_tokens.token_hash`).
