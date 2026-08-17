# SMS Processing API

Base URL: `/api/v1`. Implementation: `api/src/userApi.js`,
`api/src/adminApi.js`.

## Auth

| Audience | Header | Table |
|---|---|---|
| Customer | `X-Api-Key: <key>` | `api_keys` |
| Admin | `X-Admin-Token: <token>` | none — static secret, `.env/admin.env` |

Separate credential spaces — one type never authenticates another's
routes. Workers are never self-service: a customer can select an
available worker as `from`, but only an admin can create, list, or
revoke one. See [`admin-api.md`](./admin-api.md).

## `POST /users/token`

Open, no auth, no rate limit. Body: `{ email, phone, label? }`.

- `email` — required, validated (HTML5-spec pattern).
- `phone` — required, international format (`+` + country code). Validated
  with `libphonenumber-js`, normalized to E.164, `country` (ISO 3166-1
  alpha-2) derived from it.
- Existing email → updates `phone_number`/`country` on that user, doesn't duplicate.

`201`: `{ id, userId, email, phone, country, label, apiKey }` (`apiKey` shown once).

## `GET /numbers`

Auth: customer. Lists `worker_tokens` where `revoked_at IS NULL AND
is_public = 1` — workers are never assigned to a specific customer, so
this is every shared public number and nothing else; a private worker
never appears here for anyone.

`200`: `[{ "id": 7, "phone": "+15551234567" }, ...]` — `id` is what
`POST /sms`'s `from` expects (see below), `phone` is display-only.

## `POST /sms`

Auth: customer. Body: `{ to, from, message }`.

- `to` — validated/normalized like `phone` in `/users/token`.
- `from` — a worker `id` from `GET /numbers` (integer, **not** a phone
  number). A phone number alone can't uniquely identify a worker once
  revoked numbers become reusable (see `admin-api.md`), so the id is the
  only stable reference. Must resolve to an active, public worker —
  otherwise `400`.

Rate limit: `api_keys.daily_sms_limit` (default `10`) per rolling 24h,
counted from `sms_queue` directly — see Rate limiting below. `429` if exceeded.

`201`: `{ id, to, from, message, status: 0 }` — `from` echoes back the
worker id, not a phone number. `status` starts at `0` (queued); a
worker device pulls and sends it from there — see "Worker device flow"
in [`admin-api.md`](./admin-api.md).

## Rate limiting

Only `/sms` is limited, by `api_keys.daily_sms_limit` — read fresh per
request, not a code constant. Change it live:

```sql
UPDATE api_keys SET daily_sms_limit = ? WHERE id = ?;
```

Nothing else (`/users/token`, `/numbers`) is rate limited.

## Credentials

| Type | How | Auth |
|---|---|---|
| API key | `POST /users/token` | none — self-service |
| Worker (sender identity) | `POST /admin/workers` | admin — `X-Admin-Token` |

A customer can never create, list, or revoke a worker themselves — see
[`admin-api.md`](./admin-api.md). The API key is shown once; only its
SHA-256 hash is stored (`api_keys.key_hash`).
