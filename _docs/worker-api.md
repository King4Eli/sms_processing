# Worker API — worker integration

This is the complete guide for whatever eventually runs on the worker
device (e.g. a single-board computer driving a GSM modem, or a phone). It
never needs to touch anything else in this API — just these three routes.
Base URL: `http://<host>:<port>/api/v1`. Implementation: `api/src/workerApi.js`.

## 1. Get a worker token (once, per device)

```
POST /api/v1/worker/token
Content-Type: application/json

{ "name": "worker-livingroom" }
```

- `name` — any string identifying this device. Required.

Response `201`:

```json
{ "id": 1, "name": "worker-livingroom", "token": "wk_9f2c...redacted" }
```

`token` is shown **once** — store it on the device (e.g. in a local config
file or env var) and use it as a bearer token on every request below. This
route is open (no auth) and unlimited, so a device can call it once during
setup and keep the token indefinitely; there's no separate registration
step or approval to wait on.

Also available as a form at `/worker.html` on the frontend, if you'd
rather generate a token by hand than script it.

## 2. GET the next message — `POST /worker/sms/pull`

Despite being a `POST` (it has a side effect: it claims the row), this is
the "get work" call — poll it in a loop.

```
POST /api/v1/worker/sms/pull
Authorization: Bearer wk_9f2c...redacted
```

- **`200`** — a message was claimed. It is now yours; no other worker can
  receive it.

  ```json
  { "id": 123, "to": "+15551234567", "message": "Hello world", "status": 2 }
  ```

- **`204`** — queue is empty, nothing to claim right now. Response body is
  empty. Back off and poll again (e.g. every 5s).
- **`401`** — missing/invalid/revoked token.

This claim is atomic across every worker hitting the API at once — two
devices polling at the same instant can never receive the same message
(`SELECT ... FOR UPDATE SKIP LOCKED` + a conditional `UPDATE`, see
`workerApi.js`).

## 3. POST the result — `PATCH /worker/sms/:id/status`

Once you've actually sent the message (modem/GSM call, whatever the device
does), report it back:

```
PATCH /api/v1/worker/sms/123/status
Authorization: Bearer wk_9f2c...redacted
Content-Type: application/json

{ "status": 1 }
```

`status` must be exactly `1` — this is the only transition this route
allows, and only from a message you (or another worker) previously
claimed with step 2.

- **`200`** — `{ "id": 123, "status": 1 }`. Done, move on to the next pull.
- **`400`** — body wasn't `{"status": 1}`.
- **`404`** — no SMS with that id.
- **`409`** — that id exists but isn't currently claimed (already
  completed, or was never pulled). Don't retry this id.
- **`401`** — missing/invalid/revoked token.

There is currently **no "mark failed" call**. If sending fails on your
end, the message stays stuck at `status = 2` — don't call this route for
it. That's a deliberate gap (see `api.md` → Failure handling), not
something to work around client-side.

## Minimal loop

```text
token = load_saved_token()  # from step 1, done once ahead of time

loop forever:
  res = POST /worker/sms/pull   (Authorization: Bearer token)

  if res.status == 204:
    sleep(5)
    continue

  sms = res.json()
  ok = send_sms(sms.to, sms.message)   # actual modem/GSM send

  if ok:
    PATCH /worker/sms/{sms.id}/status   { "status": 1 }
  else:
    log_and_alert(sms.id)   # left at status=2, see above
```

No rate limit applies to any of these three routes.
