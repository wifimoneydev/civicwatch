# CivicWatch

A citizens' incident reporting app for Android, built with Apache Cordova, vanilla HTML/CSS/JavaScript and Supabase.
Built for the Bincom Academy Mobile App Development assessment.

> **Status: Phase 0 (scaffold + cloud APK build).** The app currently shows a build-diagnostics screen.
> Features are added phase by phase; the table below is only updated once a feature has been tested.

## Assessment requirements

| # | Requirement | Status |
|---|---|---|
| 1 | Submit new incident reports | Not started |
| 2 | Browse all submitted incidents | Not started |
| 3 | Submitted incidents are published automatically | Not started |
| 4 | Notifications when new incidents are added | Not started. In-app (Realtime) notifications planned first. **Background push notifications are an outstanding requirement until they have been implemented and tested on a device.** |
| 5 | Browse incidents by category | Not started |
| 6 | Reports include latitude/longitude | Not started |
| 7 | Attach pictures | Not started |
| 8 | Log in and view own reports | Not started |

## Tech stack and pinned versions

| Component | Version | Why |
|---|---|---|
| Cordova CLI | 13.0.0 | Latest stable |
| cordova-android | 15.1.0 | Latest stable; targets Android 16 (API 36) |
| JDK | 17 (Temurin) | Required by cordova-android ≥ 13 |
| Gradle | 8.14.2 | cordova-android 15 default (`cdv-gradle-config-defaults.json`) |
| Android Gradle Plugin | 8.10.1 | Bundled by cordova-android 15 |
| Android SDK | compile/target 36, min 24 (Android 7.0), Build Tools 36.0.0 | cordova-android 15 requirements |
| cordova-plugin-camera | 8.0.0 | Photo capture / gallery picker |
| cordova-plugin-geolocation | 5.0.0 | Location permission handling on Android |
| Node.js | ≥ 20.17 (CI uses 24) | cordova-android engine requirement |

All Android compilation happens on GitHub Actions. You do not need Java, Gradle, Android Studio or the Android SDK locally.

## Project structure

```
config.xml                     Cordova app config: id, permissions, network access rules
package.json                   Pinned Cordova toolchain + plugins, npm scripts
www/                           The app (HTML/CSS/JS); this is what Cordova packages
  index.html                   App shell + Content Security Policy
  css/app.css
  js/app.js
supabase/migrations/           Database schema, RLS and storage policies (Phase 1)
tests/unit/                    Automated tests (node:test, no extra dependencies)
.github/workflows/build-apk.yml  Cloud build producing the debug APK
```

## Local development (macOS, no Android tooling)

```bash
npm install          # installs Cordova + plugins locally (no global install)
npm test             # static checks on config.xml, CSP, versions, secrets
npm run serve        # serves www/ at http://localhost:8080 for browser testing
```

In a desktop browser `cordova.js` is not available, so native plugins are reported as unavailable. That is expected; device features fall back to browser APIs where possible and are verified on a real phone.

`npx cordova prepare android` also works locally. It generates `platforms/android` so the merged manifest can be inspected, but `cordova build` needs the JDK and SDK, so building only happens in CI.

## Building the APK (GitHub Actions)

The workflow `.github/workflows/build-apk.yml` runs on every push to `main`, on pull requests, and on demand (**Actions → Build Android APK → Run workflow**). It:

1. Sets up Node 24, Temurin JDK 17, Gradle 8.14.2 and Android SDK platform 36 / Build Tools 36.0.0 on `ubuntu-24.04`.
2. Runs `npm ci` and the unit tests.
3. Restores the Cordova Android platform and plugins from `package.json` (`cordova prepare android`).
4. Runs `cordova requirements android` and prints all toolchain versions to the log.
5. Builds with `cordova build android --debug`.
6. Uploads `civicwatch-debug-<commit>.apk` as the workflow artifact **civicwatch-debug-apk** (kept for 30 days).

### Downloading the APK

1. Open the repository on GitHub → **Actions** → the latest successful **Build Android APK** run.
2. Under **Artifacts**, download **civicwatch-debug-apk**. GitHub delivers it as a `.zip`; unzip it to get the `.apk`.

### Installing on an Android phone

The APK is a **debug build, signed with the Android debug key** generated on the build runner. It is not signed with a release key and is not distributed through Google Play, so Android treats it as an app from an unknown source.

1. Copy the `.apk` to the phone (USB, Google Drive, or download the artifact directly on the phone and unzip it with the Files app).
2. Open the `.apk`. When prompted, allow **Install unknown apps** for the app you opened it from (Files, Drive or Chrome).
3. Tap **Install**. Play Protect may warn about an unrecognised developer; choose **Install anyway**.
4. Open **CivicWatch**.

Each CI run uses a fresh debug key. If an install fails with "App not installed" or a signature conflict, uninstall the previous CivicWatch first.

### Phase 0 smoke test on the phone

The diagnostics screen should show:

- Cordova `deviceready`: **fired**
- Platform: **android**
- Camera plugin: **available**
- Geolocation: **available**

## Backend (Supabase)

Set up in Phase 1. Only the public project URL and the **publishable** key ever go into the app. Service-role or secret keys must never be committed or bundled.

### Email confirmation

The app supports both settings of **Authentication → Sign In / Providers → Email → Confirm email**:

- **Off:** users are signed in immediately after sign-up. This may be used temporarily so assessors can test quickly.
- **On:** the app asks users to verify their email before signing in.

**Production deployments should keep email confirmation enabled.** Turning it off is only acceptable for a time-limited assessment or demo.
