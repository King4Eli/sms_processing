# Admin API

Base URL: `/api/v1`. Implementation: `api/src/adminApi.js`. Worker
(sender identity) management — the one thing customers can never do for
themselves. There is no admin *account*: a single shared secret gates
every route here. The only client is the [smsJustu mobile
app](./worker-mobile.md) — there's no CLI or other path to register a
worker.

## Auth

```
X-Admin-Token: <token>
```

The token lives in `.env/admin.env` (`ADMIN_TOKEN=...`), loaded the same
way `.env/db.env` is (see `docker-compose.yml`) — never committed
(`.env/` is gitignored), never stored in the database, compared with a
constant-time check. If `ADMIN_TOKEN` isn't set, every route here
responds `503`. `401` on a missing or wrong token.

Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put it in `.env/admin.env` as `ADMIN_TOKEN=<value>`, then
`docker compose --env-file ./.env/db.env up -d --build` to pick it up
(compose needs a restart, not just a file edit, to re-read `env_file`).

## `POST /admin/workers`

Body: `{ name, phone, public? }`.

- `name` — required, any string.
- `phone` — required, validated/normalized like `phone` in
  `POST /users/token`. Unique among active (non-revoked) workers —
  `409` if another *active* worker already has it. A revoked worker's
  number is free to reuse.
- `public` — optional boolean, default `false`. `true` = visible to every
  customer via `GET /numbers`, selectable as `from` in `POST /sms`.
  Workers are never assigned to a specific customer — `public` is the
  only visibility control; a private worker isn't selectable by anyone
  through the customer-facing API. There's currently no other way to
  reach a worker at all — see the note on `sms_queue` below.

`201`: `{ id, name, phone, isPublic }`.

## `GET /admin/workers`

Every worker.

`200`: `[{ id, name, phone, isPublic, createdAt, revokedAt }, ...]`

## `PATCH /admin/workers/:id/revoke`

Revokes any worker — stops it being selectable as `from` in `POST /sms`.

`200` `{ id, revoked: true }` / `404` (no such id) / `409` (already
revoked).

## No worker-facing API

A worker here is purely a sender identity a customer can pick as `from`
(`POST /sms`, see [`api.md`](./api.md)) — there is no credential, no
Bearer token, and no pull/report API for a worker device to consume the
queue it lands in. `sms_queue` rows stay at `status = 0` (queued)
indefinitely; nothing currently processes them.
