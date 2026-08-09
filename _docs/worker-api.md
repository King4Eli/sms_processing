# Worker API

Base URL: `/api/v1`. Implementation: `api/src/workerApi.js`. Two HTTP
routes total — token issuance is not one of them.

## Get a token (once, per device)

No HTTP route. Run inside the container:

```bash
docker compose exec api node scripts/create-worker-token.js "worker-livingroom" "+15551234567" [--public]
node scripts/create-worker-token.js -h   # full usage
```

- `name` — any string identifying this worker.
- `phone` — the "from" number this worker sends as. Required, strictly
  validated (`libphonenumber-js`, real+valid, international format) and
  normalized to E.164 **before insert** — an invalid number is rejected
  and nothing is written. Unique across all worker tokens.
- `--public` / `-p` — makes this number visible to customers via `GET
  /numbers` and selectable as `from` in `POST /sms`. **Default: private**
  — omit it and customers can neither see nor use this number.

Prints the token once — store it on the device, send as
`Authorization: Bearer <token>` on every request below.

## Pull is scoped to your own number

A worker only ever sees SMS that were submitted with `from` equal to
*its own* `phone_number` — public or private doesn't matter here, only
who the message was addressed from. Two workers, public or private, never
receive each other's messages, and `PATCH .../status` on someone else's
message returns `403` even with a fully valid worker token. See `POST
/sms` in [`api.md`](./api.md) for how `from` gets resolved at submission.

## `POST /worker/sms/pull` — claim work

```
POST /api/v1/worker/sms/pull
Authorization: Bearer wk_...
Content-Type: application/json

{ "count": 5 }
```

- `count` — optional, integer `1`–`100`, default `1`. Must be a strict
  integer: `2.5`, `"3"`, `0`, negative, or `>100` all → `400`.

`200` always, body is an array (possibly `[]` if the queue is empty):

```json
[
  { "id": 123, "to": "+15551234567", "message": "Hello world", "status": 2 }
]
```

Claim is atomic across every worker polling at once — concurrent requests
never receive overlapping rows (`SELECT ... FOR UPDATE SKIP LOCKED` +
a batch `UPDATE` scoped to exactly the locked ids, one transaction).
`401` on missing/invalid/revoked token.

## `PATCH /worker/sms/:id/status` — report outcome

Only from a message *you* claimed via pull (row must be `status=2`).

**Sent:**
```json
{ "status": 1 }
```
`200` `{ "id": 123, "status": 1 }`. Sets `processed_at`. Terminal.

**Failed — re-queues for another pull:**
```json
{ "status": 0, "error_message": "modem timeout" }
```
`error_message` is required with `status: 0`. `200` `{ "id": 123, "status": 0 }`.
Row goes back to `status=0`; only the same worker (same `phone_number`)
can pull it again, incrementing `attempts`. `error_message` persists even
if that retry later succeeds — it's a last-failure record, not cleared on
success.

Other responses: `400` (bad body), `403` (this id was submitted `from` a
different worker's number — not yours to update even if you know the id),
`404` (no such id), `409` (id exists but isn't currently `status=2` —
already done, never claimed, or claimed by a report that already resolved it).

No automatic timeout/requeue exists — a worker that crashes after pulling
without ever calling this route leaves the message stuck at `status=2`
indefinitely. Reporting failure explicitly is the only way back to `status=0`.

## Loop

```text
token = load_saved_token()

loop forever:
  batch = POST /worker/sms/pull  { "count": 5 }
  if batch is empty:
    sleep(5); continue

  for sms in batch:
    if send_sms(sms.to, sms.message):           # actual modem/GSM send
      PATCH /worker/sms/{sms.id}/status  { "status": 1 }
    else:
      PATCH /worker/sms/{sms.id}/status  { "status": 0, "error_message": "..." }
```

No rate limit on either route.
