# SMS Processing API

Base URL: `/api/v1`. Implementation: `api/src/userApi.js`, `api/src/workerApi.js`.

## Auth

| Audience | Header | Table |
|---|---|---|
| Customer | `X-Api-Key: <key>` | `api_keys` |
| Worker | `Authorization: Bearer <token>` | `worker_tokens` |

Separate tables — one credential type never authenticates the other's routes.

## `POST /users/token`

Open, no auth, no rate limit. Body: `{ email, phone, label? }`.

- `email` — required, validated (HTML5-spec pattern).
- `phone` — required, international format (`+` + country code). Validated
  with `libphonenumber-js`, normalized to E.164, `country` (ISO 3166-1
  alpha-2) derived from it.
- Existing email → updates `phone_number`/`country` on that user, doesn't duplicate.

`201`: `{ id, userId, email, phone, country, label, apiKey }` (`apiKey` shown once).

## `POST /sms`

Auth: customer. Body: `{ to, message }`. `to` validated/normalized like `phone` above.

Rate limit: `api_keys.daily_sms_limit` (default `10`) per rolling 24h,
counted from `sms_queue` directly — see Rate limiting below. `429` if exceeded.

`201`: `{ id, to, message, status: 0 }`

## `POST /worker/sms/pull`

Auth: worker. Body: `{ count? }` — integer, `1`–`100`, default `1`.
Non-integers (`2.5`, `"3"`, negative, `0`, `>100`) → `400`.

Atomically claims up to `count` oldest `status=0` rows (`0 -> 2`). Always
`200` with a JSON array (possibly empty) of `{ id, to, message, status }`.
Full detail incl. concurrency guarantee: [`worker-api.md`](./worker-api.md).

## `PATCH /worker/sms/:id/status`

Auth: worker. Requires the row currently be `status=2`.

- `{ "status": 1 }` → `2 -> 1`, done.
- `{ "status": 0, "error_message": "..." }` → `2 -> 0`, re-queued.

`200` / `400` (bad body) / `404` (no such id) / `409` (not currently claimed).

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

Nothing else (`/worker/*`, `/users/token`) is rate limited.

## Credentials

| Type | How | Auth |
|---|---|---|
| API key | `POST /users/token` | none — self-service |
| Worker token | `docker compose exec api node scripts/create-worker-token.js "<name>"` | requires container exec access, not HTTP |

Worker tokens grant full pull/complete access to every customer's queue,
so unlike API keys there's no HTTP route for creating one. Both credential
types are shown once; only their SHA-256 hash is stored
(`api_keys.key_hash` / `worker_tokens.token_hash`).
