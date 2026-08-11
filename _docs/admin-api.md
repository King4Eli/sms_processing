# Admin API

Base URL: `/api/v1`. Implementation: `api/src/adminApi.js`. Worker
(device) management — the one thing customers can never do for
themselves. There is no admin *account*: a single shared secret gates
every route here.

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

Body: `{ name, phone, public?, userId? }`. The HTTP equivalent of
`scripts/create-worker-token.js`, with one addition: `userId`.

- `name` — required, any string.
- `phone` — required, validated/normalized like `phone` in
  `POST /users/token`. Unique across all worker tokens — `409` if
  already registered.
- `public` — optional boolean, default `false`. `true` = visible to every
  customer via `GET /numbers`, selectable as `from` by anyone.
- `userId` — optional. Ties the worker to one customer account
  (`worker_tokens.user_id`) — that customer alone may use it as `from`,
  public or not, in addition to whatever `public` grants everyone else.
  `400` if the id doesn't exist. Omit for a global/unassigned worker,
  the same shape `scripts/create-worker-token.js` produces.

`201`: `{ id, name, phone, isPublic, userId, token }` (`token` shown
once — this is the worker's `Authorization: Bearer` credential for
`/worker/*`, see [`worker-api.md`](./worker-api.md)).

## `GET /admin/workers`

Every worker, across every customer — not scoped like the customer-side
`GET /numbers`. Never returns the token.

`200`: `[{ id, userId, name, phone, isPublic, createdAt, revokedAt }, ...]`
(`userId` is `null` for global/unassigned workers.)

## `PATCH /admin/workers/:id/revoke`

Revokes any worker, owned or global — no ownership check, unlike a
hypothetical customer-facing revoke. Immediately stops it authenticating
against `/worker/*` and stops it being selectable as `from`.

`200` `{ id, revoked: true }` / `404` (no such id) / `409` (already
revoked).
