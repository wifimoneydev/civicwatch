# CivicWatch

CivicWatch is an Android app for reporting incidents in your community. Citizens sign in, report an
incident with its category, location and an optional photo, and everyone else signed in can see it
straight away. Users who have the app open get an in-app alert when someone else reports something new.

It was built for the **Bincom Academy Mobile App Development assessment** using Apache Cordova,
plain HTML, CSS and JavaScript (no framework), and Supabase. The Android APK is built in the cloud by
GitHub Actions.

**Submission files:** the Android APK (from GitHub Actions, see [Building the APK](#building-the-apk)),
the `www/` folder and `config.xml`.

---

## The eight Bincom requirements

| # | Requirement | How CivicWatch does it | Verified |
|---|---|---|---|
| 1 | Submit new incident reports | The **Report** tab has a title, category, description, location and optional photo. Validation matches the database constraints exactly. Tapping repeatedly can't create duplicates, and if a request fails everything the user typed is kept. | Manual test by the developer; automated browser test (mocked); live `check:report` script |
| 2 | Browse all submitted incidents | The **Incidents** feed loads real reports from Supabase, newest first, 10 at a time with **Load more** and **Refresh**. Each item shows the title, category, time, status and photo thumbnail. Tap any report for its full details. | Automated browser test (mocked); live query check |
| 3 | Reports are published automatically | A report is visible to every signed-in user as soon as it is saved. There is no approval step. Each report is labelled **Unverified**, and only an administrator can change that label. | Database policy tests (local Postgres); live `check:policies` (20/20 passed) |
| 4 | Notifications for new incidents | **In-app notifications** through Supabase Realtime. While the app is open, a banner announces each report from another user, and tapping it opens that report. The feed updates live. **Notifications are not shown while the app is closed** (see [Notifications](#notifications)). | Automated browser test (Realtime simulated); live `check:realtime` script |
| 5 | Browse by category | Filter buttons: **All, Accident, Fighting, Rioting, Fire, Theft, Other**. The filter runs in the database query, so paging works within the chosen category. | Automated unit and browser tests; live query check |
| 6 | Latitude and longitude | **Use my location** takes a fresh GPS reading and shows its accuracy. Coordinates can also be typed in by hand. Ranges are checked, and the app never fills in made-up coordinates. Reports record whether the location came from GPS or was typed. | Manual test; automated browser test with emulated GPS |
| 7 | Attach pictures | **Take photo** or **Choose photo** using the phone's camera or gallery (cordova-plugin-camera); a file picker in a browser. Photos are resized to at most 1600 px, saved as JPEG under 5 MB with hidden metadata removed, and uploaded to the user's own storage folder. | Manual test; automated browser test |
| 8 | Log in and see own reports | Email and password sign-up, log-in and log-out. Sessions survive app restarts. **My Reports** lists only the signed-in user's reports, each of which opens its details. | Manual test; automated browser test; live `check:policies` |

---

## How it works

```
 Android phone (Cordova WebView)                      Supabase project
 ┌────────────────────────────────┐                ┌────────────────────────────────┐
 │ www/  HTML + CSS + vanilla JS  │  HTTPS (REST)  │ Auth      email + password     │
 │  supabase-js (bundled locally) │ ─────────────► │ Postgres  incidents table, RLS │
 │  camera + geolocation plugins  │                │ Storage   incident-photos      │
 │                                │ ◄───────────── │ Realtime  new-incident events  │
 └────────────────────────────────┘  WSS (Realtime)└────────────────────────────────┘
```

- The app only ever uses the **publishable** Supabase key. Every rule about who may read or change what is
  enforced inside the database by Row Level Security, so the rules hold even if someone tampers with the app.
- All JavaScript, including supabase-js, ships inside the APK; nothing is downloaded from a CDN. A strict
  Content Security Policy only allows connections to `*.supabase.co`.

### Why Supabase instead of WordPress

WordPress was optional. Supabase was chosen because it provides, as one managed service, everything this app
needs:

- **Authentication** with sessions that refresh automatically.
- A **PostgreSQL database** with **Row Level Security**, so access rules ("users can only submit as
  themselves", "only admins can verify") live next to the data and can be tested.
- **File storage** for photos, with per-folder upload rules, size limits and allowed file types.
- **Realtime** change events for live notifications, applying the same read rules.

Doing the same with WordPress would mean extra plugins for a mobile API, authentication, media handling and
live events, plus hosting and maintaining PHP. Supabase works directly from the client with no custom server
code.

---

## Setup

### 1. Supabase

1. Create a Supabase project (the free tier is enough).
2. Go to **SQL Editor → New query**, paste all of
   [`supabase/migrations/001_incidents_storage_realtime.sql`](supabase/migrations/001_incidents_storage_realtime.sql),
   and click **Run**. It is safe to run again. It creates:
   - the `incidents` table, with constraints and indexes
   - the access policies
   - the `incident-photos` storage bucket (public read, 5 MB, JPEG/PNG/WebP)
   - Realtime for the `incidents` table
3. Go to **Authentication → URL Configuration** and set the **Site URL** to a page that loads, for example
   this repository's GitHub page. Email confirmation links redirect there after confirming the account.
4. Check that **Authentication → Sign In / Providers → Email** is enabled. **Confirm email** may be on
   (recommended, and the current setting) or off; the app handles both.

### 2. App configuration

Edit [`www/js/config.js`](www/js/config.js) and fill in the **Project URL** and the **publishable key** from
**Project Settings → API Keys / Data API**:

```js
SUPABASE_URL: 'https://<project-ref>.supabase.co',
SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_...'
```

Never put a secret key (`sb_secret_…`), the `service_role` key or the database password in the app. `npm test`
fails if one appears anywhere in `www/`. The publishable key is designed to be public, so commit `config.js`
for the cloud build to use it.

### 3. Local tools (macOS, no Android SDK needed)

```bash
npm install              # Cordova, plugins and test tools, installed locally
npm run check:supabase   # confirms the project is reachable and set up
npm run serve            # opens the app at http://localhost:8080 for browser testing
```

## Building the APK

All Android compilation happens on **GitHub Actions**
([`.github/workflows/build-apk.yml`](.github/workflows/build-apk.yml)). Java, Gradle, Android Studio and the
Android SDK are not needed locally.

The workflow runs on every push to `main`, and on demand from **Actions → Build Android APK → Run
workflow**. On Ubuntu 24.04 it sets up Node 24, JDK 17, Gradle 8.14.2 and Android SDK 36 / Build Tools 36.0.0,
runs the unit tests, then builds with `cordova build android --debug`.

1. Open **Actions** on GitHub, then the latest successful **Build Android APK** run, and download the
   **civicwatch-debug-apk** artifact (a `.zip` containing the `.apk`).
2. Copy the `.apk` to the phone and open it. Allow **Install unknown apps** for the app you opened it from,
   then tap **Install**, and **Install anyway** if Play Protect warns about an unrecognised developer.

The APK is a **debug build**, not a Play Store release. Since version 1.0.0 every build is signed with the
same committed **debug-only** key ([`signing/`](signing/README.md)), so a new APK installs over the previous
one and keeps the login. Builds made before 1.0.0 used a random key each time: if an older CivicWatch is
installed, **uninstall it once** before installing 1.0.0. Otherwise Android reports "App not installed" and
keeps the old app.

**Which build is installed?** The version and commit are shown under **App diagnostics** (login screen and
Profile), e.g. `Version 1.0.0 · c28497a`. The workflow also checks every APK before uploading it:
- the packaged `www/` files match the commit exactly
- the build info names that commit
- the APK is signed with the expected key

| Component | Version |
|---|---|
| Cordova CLI / cordova-android | 13.0.0 / 15.1.0 (targets Android 16, API 36; minimum Android 7.0, API 24) |
| cordova-plugin-camera / cordova-plugin-geolocation | 8.0.0 / 5.0.0 |
| JDK / Gradle / Android Gradle Plugin | 17 / 8.14.2 / 8.10.1 |
| @supabase/supabase-js | 2.117.2, bundled in `www/vendor/` |

**Android permissions:** internet, and fine and coarse location (from the geolocation plugin). The camera
and gallery open through the system's own apps, so no camera or storage permission is requested. GPS is
optional, so phones without GPS can still install the app.

---

## Features in detail

### Accounts and sessions
- Email and password only. Passwords need at least 8 characters, including a letter and a number.
- **With email confirmation on,** sign-up shows "Check your email" and the user is **not** logged in until
  they confirm and log in. **With it off,** they are logged in straight away. Production should keep
  confirmation on.
- Sessions are stored in the app and restored *before* any signed-in screen is shown.
  - If a session has expired, the user sees "Your session has expired" and the login screen.
  - If the phone is offline while a session needs refreshing, the app shows **Try again** and keeps the
    session.
- **Logging out** clears the session even when offline. It also removes the live subscription and clears the
  previous user's feed, reports, draft report and alerts, so the next person on the same phone sees none of it.

### Feed and categories
- Reports are loaded newest first, **10 per page**. **Load more** continues from the last report shown, using
  a cursor based on the report's time and ID, so reports are never skipped or duplicated when new ones arrive.
- Changing category goes back to the first page. If the user switches category quickly, a slow response
  for the previous category is ignored, so the list never shows the wrong category.
- Loading, empty ("No Rioting reports yet"), error (with **Try again**) and live-connection states are shown
  separately, so a lost live connection is never mistaken for an empty feed.

### Incident details
- Open a report from the feed, My Reports or a notification. The details show the photo, category, status,
  title, full date and time, description, latitude and longitude, and whether the location came from GPS or
  was typed in.
- All report text is displayed as plain text, never as HTML.
- If the photo fails to load, a message replaces it. An unknown or deleted report shows "Report unavailable",
  and a network error shows **Try again**.
- The on-screen back arrow and the Android back button both return to the list you came from, with your
  category filter kept.

### Notifications
- After login the app listens for new reports through **Supabase Realtime**. When another user submits one,
  a banner shows the category and title. Tapping it opens the report, and the feed updates live (within the
  selected category).
- The banner never appears for:
  - your own reports
  - reports that already existed when you logged in
  - the same report twice
- When the live connection drops, the feed says **"Live updates unavailable"**. When the connection comes
  back, or the app returns to the foreground, or the network reconnects, the app reloads the feed to pick up
  anything missed. Realtime does not replay missed events.
- **Notifications only work while the app is open and on screen.** Nothing is shown when the app is closed
  or in the background. Alerts for a closed app would need a push notification service (for example Firebase
  Cloud Messaging plus a server-side sender), which is deliberately left out of this MVP.

### Reporting
- If the database rejects a report after its photo was uploaded, the photo is deleted.
- If the connection drops and the result is unknown, the app checks whether the report was saved. The photo
  is never deleted unless the app has confirmed that no report uses it.
- Success is only shown after the database confirms the save.

---

## Security and privacy

| Who | Can | Cannot |
|---|---|---|
| Signed out | Nothing (all queries return zero rows; Realtime sends nothing) | Read, submit or upload |
| Signed-in user | Browse all reports; submit reports as themselves; delete their own reports; upload photos into `incident-photos/<their user id>/` | Submit as someone else; set the verification status, time or ID; edit any report; delete other people's reports; upload anywhere else |
| Administrator (Supabase dashboard) | Mark reports verified or rejected | — |

- **Coordinates are visible to every signed-in user.** The report form says so, and tells users to use their
  current location only if they are at the incident.
- **Photos have public URLs.** The bucket is public so photos can be shown without generating a temporary
  link for each one. This means:
  - anyone who has a photo's exact URL can open it, even without signing in;
  - nobody can list the bucket's contents;
  - file names contain a random ID;
  - hidden metadata, including the GPS location stored in the photo, is removed before upload.

  Users should not photograph anything more sensitive than the report itself.
- Other users never see account details. Reports and Realtime events contain only the report's own fields;
  the submitter is identified only by an opaque ID, which the app does not display.

---

## Testing

### Automated (no accounts needed)

| Command | What it covers | Mocked or live |
|---|---|---|
| `npm test` | 104 unit tests: config and secret checks, Content Security Policy, version pins, **access policies run against the real migration in local Postgres (PGlite)**, validation compared with the database constraints, session logic, the submit and cleanup logic, feed paging, categories, out-of-date responses, the notification filter and subscription cleanup. Also run by GitHub Actions before every build. | Local Postgres; no network |
| `npm run test:e2e` | Drives the real app in headless Chrome: start-up the way it runs on Android, with `deviceready` (16 checks), auth (54), reporting (52), and the feed, details and notifications (62). | Supabase responses and Realtime events are simulated. The auth suite includes 6 live checks that create no accounts |

### Live checks against your project (prompt for test-account passwords, never print them, delete their test data)

| Command | Accounts | What it proves |
|---|---|---|
| `npm run check:supabase` | none | Project URL and key, Auth, the table, the storage bucket and Realtime are reachable |
| `npm run check:policies` | two | Ownership rules, shared browsing, users cannot verify reports, photo upload rules (**passed 20/20**) |
| `npm run check:report` | one | A real submission with a photo, My Reports, and that the photo is deleted if the database rejects the report |
| `npm run check:realtime` | two | B receives A's new report via Realtime; notification rules; signed-out clients receive nothing; category feed and details; every channel removed afterwards |

### Two-account browser test (notifications)

Run `npm run serve`, then open http://localhost:8080 in **two different browsers**, or one normal window and
one private window, so the logins don't share storage.

1. Window B: log in as **account B**. You land on **Incidents** and should see **"Live: new reports appear
   automatically"**. Leave the window open.
2. Window A: log in as **account A**, open **Report**, and submit a report with category **Rioting**, a title
   such as "Two-account test", a description and coordinates. A photo is optional.
3. Window B: within a few seconds a banner should appear: **"New Rioting report – Two-account test – Tap to
   view"**. The report should also appear at the top of the feed.
4. Window A should **not** show a banner for its own report.
5. Window B: tap the banner. The details should show the title, description, category Rioting, coordinates,
   time, **Unverified** and the photo if one was added.
6. Window B: tap **‹** to go back, then tap **Rioting**. The report should be listed. Tap **Fighting**: it
   should not be listed.
7. Window A: delete the test report afterwards in Supabase (**Table Editor → incidents**), or leave it as
   demo data.

---

## Limitations and remaining checks

- **No notifications while the app is closed.** In-app alerts only work while the app is open. Push
  notifications would need Firebase Cloud Messaging and a server-side sender, which is beyond this MVP.
- **Phone-only behaviour must be checked on a device:**
  - camera, gallery and location permission dialogs
  - real GPS fixes
  - photo orientation from the camera
  - live alerts while the phone sleeps and wakes (the app reloads the feed when it returns to the foreground)
  - the Android back button
- **Live two-account checks still to run:** `npm run check:realtime` and the two-account browser test above.
- **Not built:** password reset, editing reports, moderation tools, maps and search are outside the
  assessment scope. Administrators verify reports in the Supabase dashboard.
- **Supabase free tier:** projects pause after a period of inactivity. Open the app or dashboard before a
  demo. The built-in email service only sends a few confirmation emails per hour.
- The APK is debug-signed, not a Play Store release.

---

## Project structure

```
config.xml                      Cordova config: app id, Android API levels, network rules
www/                            The app that Cordova packages
  index.html                    All screens + Content Security Policy
  css/app.css                   Styles (navy/white/teal, mobile-first)
  js/config.js                  Supabase Project URL + publishable key
  js/config-check.js            Rejects missing, malformed or secret keys
  js/supabase-client.js         The single shared Supabase client
  js/auth-logic.js, session.js  Validation, readable errors, session restore/expiry
  js/report-logic.js            Report rules (mirror the database constraints)
  js/report-submit.js           Photo upload + report insert + leftover-photo cleanup
  js/photo.js, report-view.js   Camera/gallery/file -> resized JPEG; report form
  js/feed.js                    Feed queries, paging, categories, Realtime, notification rules
  js/feed-view.js               Feed, details and notification screens
  js/my-reports.js              My Reports query (signed-in user only)
  js/diagnostics.js, app.js     Diagnostics screen; router and screen guards
  vendor/supabase-js-2.117.2.js Pinned Supabase client (+ licence)
supabase/migrations/            The SQL setup (table, policies, bucket, Realtime)
scripts/                        Live checks (check-*.mjs) and the vendoring script
tests/unit/                     node:test unit tests (incl. Postgres policy tests)
tests/e2e/                      Headless-Chrome tests + mock Supabase harness
.github/workflows/build-apk.yml Cloud APK build
```
