# SMS Processing API

Base URL: `http://<host>:<port>/api/v1`

Two completely separate credential spaces:

| Audience | Header | Table | Can do |
|---|---|---|---|
| Customer (website/API) | `X-Api-Key: <key>` | `api_keys` | Submit SMS |
| Worker (the device sending SMS) | `Authorization: Bearer <token>` | `worker_tokens` | Pull + complete SMS |

A customer API key is rejected by every `/worker/*` route and vice versa —
they're validated against different tables, not just different scopes on
the same table.

## Customer: submit an SMS

```
POST /api/v1/sms
X-Api-Key: <customer api key>
Content-Type: application/json

{
  "to": "+15551234567",
  "message": "Hello world"
}
```

Response `201`:

```json
{ "id": 123, "to": "+15551234567", "message": "Hello world", "status": 0 }
```

Row is inserted with `status = 0` (queued).

## Worker: pull the next SMS

```
POST /api/v1/worker/sms/pull
Authorization: Bearer <worker token>
```

Atomically claims the single oldest `status = 0` row and flips it to
`status = 2`, setting `pulled_at` and incrementing `attempts`. Implemented
as `SELECT ... FOR UPDATE SKIP LOCKED` + conditional `UPDATE` inside one
transaction (see `api/src/workerApi.js`), so two workers polling at the
same instant can never receive the same row.

- **200** — a message was claimed:

  ```json
  { "id": 123, "to": "+15551234567", "message": "Hello world", "status": 2 }
  ```

- **204** — queue is empty, nothing to claim. Poll again later (recommend a
  few seconds of backoff between empty polls).

## Worker: report an SMS as sent

```
PATCH /api/v1/worker/sms/:id/status
Authorization: Bearer <worker token>
Content-Type: application/json

{ "status": 1 }
```

Only the `2 -> 1` transition is accepted. The server re-checks the row is
currently `status = 2` as part of the same `UPDATE`, so this is also race-safe.

- **200** — `{ "id": 123, "status": 1 }`
- **400** — body isn't exactly `{"status": 1}`
- **404** — no SMS with that id
- **409** — SMS exists but isn't currently claimed (already processed, never
  pulled, or id is otherwise not in `status = 2`)

## Suggested worker loop

```text
loop forever:
  res = POST /worker/sms/pull
  if res.status == 204:
    sleep(POLL_INTERVAL_SECONDS)   # e.g. 5s
    continue
  sms = res.json()
  try:
    send_sms(sms.to, sms.message)   # actual GSM/modem send
    PATCH /worker/sms/{sms.id}/status  { "status": 1 }
  except:
    # message stays at status=2; see "Failure handling" below
    log_and_alert(sms.id)
```

## Failure handling (not built yet)

The spec only defines the two normal transitions (`0->2`, `2->1`). If a
send fails, the current schema/API intentionally does **not** auto-revert
`2 -> 0` or expose a "mark failed" endpoint — a message stuck at `status =
2` is left for manual/operational follow-up (the `attempts` and
`error_message` columns exist on `sms_queue` for this, unused by the API
today). Add a retry/failure endpoint later if needed; don't build it
speculatively now.

## Rate limiting

`/sms` enforces a per-API-key daily submission limit, read from
`api_keys.daily_sms_limit` (default `10`, set on the row - not a constant
in code). Enforced by comparing that value against `COUNT(*) FROM sms_queue
WHERE api_key_id = ? AND created_at >= NOW() - INTERVAL 1 DAY` (backed by
`idx_sms_queue_api_key_created`) in `api/src/userApi.js`. No separate
rate-limit table, no IP dimension anywhere. Exceeding it returns `429`.

To change a key's limit: `UPDATE api_keys SET daily_sms_limit = ? WHERE id
= ?` — takes effect immediately, no restart.

`/worker/*`, `/users/token`, and `/worker/token` are **not** rate
limited.

## Provisioning credentials

Self-service, no auth required and no rate limit — anyone who can reach the
API can mint a credential, as often as they want. This is intentional per
current requirements, not an oversight: there is no signup/account system,
so these are the only entry points that create `users` / `api_keys` /
`worker_tokens` rows. In particular `/worker/token` hands out full
pull-and-complete access to *every* customer's queued SMS to anyone who
calls it, with nothing slowing down repeated calls — if that's ever a
problem, put a gate in front of it (shared setup code, allowlist, etc.)
before exposing this API publicly.

### Customer: get an API key

```
POST /api/v1/users/token
Content-Type: application/json

{ "email": "customer@example.com", "phone": "+15551234567", "label": "prod key" }
```

`201` — `{ "id": 1, "userId": 1, "email": "...", "phone": "+15551234567", "country": "US", "label": "...", "apiKey": "ak_..." }`
(`label` is optional; `email` and `phone` are required).

- `email` is validated against the HTML5-spec pattern, not just "contains
  an @".
- `phone` must be a real, valid number in international format (leading
  `+` and country code, e.g. `+15551234567`) - validated with
  `libphonenumber-js`, not a regex. It's normalized to E.164 before
  storage, and `country` (ISO 3166-1 alpha-2, e.g. `US`, `GB`) is derived
  from it and stored alongside. Invalid or ambiguous (no country code)
  numbers are rejected with `400`.
- `POST /sms`'s `to` field is validated and normalized the same way before
  the `sms_queue` row is inserted.

Creates the `users` row if the email hasn't been seen before, otherwise
updates `phone_number`/`country` on the existing row. Also available via
the "Get API key" page in `/frontend`.

### Worker: get a worker token

See [`worker-api.md`](./worker-api.md) for the full worker integration
guide. Also available via the "Get worker token" page in `/frontend`.

The plaintext credential is shown once in the response; only its SHA-256
hash is stored (`api_keys.key_hash` / `worker_tokens.token_hash`).
