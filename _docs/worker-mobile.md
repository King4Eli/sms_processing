# smsJustu (mobile)

Android app at `frontend_worker_mobile/`. Package
`com.smsjustu.app`, app label "smsJustu". A mobile client for
the [Admin API](./admin-api.md) only — it manages worker records
(sender identities customers can pick as `from`; create/list/revoke).
There is no worker-facing pull/delivery API in this system at all (see
"No worker-facing API" in `admin-api.md`) — this app has nothing to do
with sending SMS.

Kotlin + Jetpack Compose, minSdk 24, targetSdk 36. Networking is OkHttp
(`java.net.HttpURLConnection` on Android rejects the `PATCH` method
required by the revoke route, so plain `HttpURLConnection` isn't an
option here).

## Screens and files

- `MainActivity.kt` — single-activity Compose UI: worker list, create
  dialog, revoke confirmation, settings dialog. No navigation library;
  everything is dialogs over one screen.
- `AdminApiClient.kt` — thin wrapper over `/api/v1/admin/*`
  (`listWorkers`, `createWorker`, `revokeWorker`), `X-Admin-Token` on
  every request. Talks to the same admin routes documented in
  [`admin-api.md`](./admin-api.md).
- `Settings.kt` — `SharedPreferences` wrapper: server URL, admin token,
  pull toggle, background-sync toggle. Nothing here is encrypted; the
  admin token is a static shared secret with the same blast radius as
  putting it in `.env/admin.env`, treat a device holding it accordingly.
- `SyncService.kt`, `StartServiceReceiver.kt`, `RestartScheduler.kt`,
  `SmsJustuApplication.kt` — the background-service machinery, see below.

## Setup

On first launch (or whenever the admin token is blank) a Settings
dialog opens automatically:

- **Server URL** — defaults to `https://sms-gateway.q1-site.site`;
  point it at `http://10.0.2.2:3000` from an emulator to hit a host
  machine's `docker compose` API.
- **X-Admin-Token** — the same value as `ADMIN_TOKEN` in
  `.env/admin.env`. Without it every `/admin/*` call 401s (or 503s if
  the server itself has no `ADMIN_TOKEN` set).

Saving refreshes the worker list immediately. `usesCleartextTraffic` is
on so plain `http://` server URLs work during local testing.

## Worker management

Straight CRUD-ish mapping onto the admin routes:

| Action | Route | UI |
|---|---|---|
| List | `GET /admin/workers` | main list, pull the refresh icon or reopen the app |
| Create | `POST /admin/workers` | FAB → name / phone / public switch |
| Revoke | `PATCH /admin/workers/:id/revoke` | per-card "Revoke" button → confirm dialog |

Server-side validation errors (bad phone format, duplicate active
number, etc.) surface verbatim in a Snackbar — the client does no
independent phone-number validation itself.

## Background sync service

Optional, off by default. The Settings dialog has two independent
switches:

- **Pull** — the master on/off for the sync service. Toggling it on
  starts `SyncService` immediately (and pulls right away); toggling it
  off stops the service. The home screen shows the current state as
  "Pull: On" / "Pull: Off".
- **Run in background** — persistence policy only: auto-starts on boot
  and restarts the service if the process is killed or crashes. It has
  no effect unless Pull is also on — both flags are checked before any
  boot/crash restart fires.

Since list/create/revoke are all on-demand taps, the service needs an
actual job to justify staying resident — it polls `GET /admin/workers`
every 60s (`SyncService.SYNC_INTERVAL_MS`) and keeps a low-priority,
non-dismissible notification updated with the active worker count and
last-sync time. Tapping the notification opens the app.

Mechanics:

- **`SyncService`** — foreground service, type `specialUse` (declared
  via `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` in the manifest to avoid the
  execution-time caps Android puts on `dataSync`-type services).
  `START_STICKY` so the system re-creates it after low-memory kills.
  Acquires a partial wake lock only for the duration of each sync call,
  not continuously.
- **`StartServiceReceiver`** — `BroadcastReceiver` for
  `BOOT_COMPLETED` / `QUICKBOOT_POWERON` / `MY_PACKAGE_REPLACED` (app
  updated) and a private `RESTART_SYNC` action. Starts the service only
  if both `Settings.backgroundSyncEnabled` and `Settings.pullEnabled`
  are true; otherwise a no-op.
- **`RestartScheduler`** — schedules a `RESTART_SYNC` broadcast via
  `AlarmManager` a couple seconds out. Used by both
  `SyncService.onTaskRemoved()` (some OEMs kill services when the app
  is swiped from recents) and the crash handler below. Same
  `backgroundSyncEnabled && pullEnabled` gate as above.
- **`SmsJustuApplication`** — installs a
  `Thread.setDefaultUncaughtExceptionHandler` that calls
  `RestartScheduler` before re-throwing to the default handler, so an
  unhandled crash anywhere in the app still leaves the sync service
  restarting a couple seconds later. Also starts the service on cold
  process start if `Settings.pullEnabled` is true.

Enabling Pull also requests `POST_NOTIFICATIONS` (Android 13+,
best-effort — the service runs fine without it, the notification just
won't show) and offers a button to launch the system's "exempt from
battery optimization" dialog, since aggressive OEM battery managers can
otherwise kill it despite the foreground-service exemption.

**Known limitation**: if the user (or the OS) force-stops the app,
Android puts it into a "stopped" state that suppresses `BOOT_COMPLETED`
and other implicit broadcasts until the app is manually launched again
— there's no way around this from app code. Opening the app once after
a force-stop is enough to restore normal boot-start behavior.

## Building / installing

```bash
cd frontend_worker_mobile
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

No secrets are baked into the build — the admin token is entered at
runtime and stored in the app's private `SharedPreferences` only.
