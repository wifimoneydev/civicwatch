# Debug signing key

`civicwatch-debug.p12` is a **debug-only** signing key, committed on purpose so every
GitHub Actions build is signed with the same key. Android only installs an update
over an existing app when both are signed with the same key; without this, each CI
run generated a fresh key and new APKs failed to install over older ones.

- Store/key password: `android` (the standard public Android debug password)
- Alias: `androiddebugkey`, type PKCS12, valid 30 years
- Used via `build.json` (`cordova build android --debug --buildConfig build.json`)

**Never use this key for a Play Store / production release.** Anyone with this
repository can sign an APK with it.
