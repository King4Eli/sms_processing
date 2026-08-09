# SMS Processing API

Base URL: `http://<host>:<port>/api/v1`

Two completely separate credential spaces:

| Audience | Header | Table | Can do |
|---|---|---|---|
| Customer (website/API) | `X-Api-Key: <key>` | `api_keys` | Submit SMS |
| Worker (Raspberry Pi / mobile sender) | `Authorization: Bearer <token>` | `worker_tokens` | Pull + complete SMS |

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
transaction (see `api/src/services/smsQueueService.js`), so two workers
polling at the same instant can never receive the same row.

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

`/sms` and `/worker/*` are rate limited per credential (`api_keys.id` /
`worker_tokens.id`), not per IP — see `rate_limit_hits` in the schema and
`api/src/services/rateLimitService.js`. A row is inserted per allowed
request and pruned once it's outside the window, so the limit is enforced
against the database rather than in-process memory (correct across
multiple API instances, unlike an in-memory limiter). Defaults:

- Customer `/sms`: 60 requests / 60s per API key
- Worker `/worker/*`: 120 requests / 60s per worker token (generous
  headroom for continuous polling)

`/users/token` and `/raspberrypi/token` are **not** rate limited — see
below, this is intentional.

## Provisioning credentials

Self-service, no auth required and no rate limit — anyone who can reach the
API can mint a credential, as often as they want. This is intentional per
current requirements, not an oversight: there is no signup/account system,
so these are the only entry points that create `users` / `api_keys` /
`worker_tokens` rows. In particular `/raspberrypi/token` hands out full
pull-and-complete access to *every* customer's queued SMS to anyone who
calls it, with nothing slowing down repeated calls — if that's ever a
problem, put a gate in front of it (shared setup code, allowlist, etc.)
before exposing this API publicly.

### Customer: get an API key

```
POST /api/v1/users/token
Content-Type: application/json

{ "email": "customer@example.com", "label": "prod key" }
```

`201` — `{ "id": 1, "userId": 1, "email": "...", "label": "...", "apiKey": "ak_..." }`
(`label` is optional). Creates the `users` row if the email hasn't been seen
before. Also available via the "Get API key" page in `/frontend`.

### Worker: get a worker token

```
POST /api/v1/raspberrypi/token
Content-Type: application/json

{ "name": "pi-livingroom" }
```

`201` — `{ "id": 1, "name": "pi-livingroom", "token": "wk_..." }`. Also
available via the "Get worker token" page in `/frontend`.

### CLI alternative

The same logic is also available as scripts in `/api`, useful for scripting
or if you gate the HTTP routes later and still need a side-channel:

```bash
cd api
npm run create-worker-token -- "pi-livingroom"
npm run create-api-key -- "customer@example.com" "prod key"
```

Either way, the plaintext credential is shown once; only its SHA-256 hash
is stored.
