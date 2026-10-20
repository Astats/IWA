# Android release builds

How to build signed Android releases of the Budget app (BUILD_PLAN Step 4.4). The native project
lives in `apps/web/android` and wraps the production web build (`apps/web/dist`). There is no
native iOS app (out of scope since 2026-10-20); iPhone users install the PWA. Commands run from
`apps/web` unless stated otherwise.

## 1. Prerequisites

- Node.js 24 and pnpm 12 (see the root README), `pnpm install` done.
- Android SDK (Android Studio) and **JDK 21** installed: `@capacitor/filesystem` compiles with a
  Java 21 toolchain. Point `JAVA_HOME` (or Android Studio → Settings → Build Tools → Gradle →
  Gradle JDK) at it; JDK 25 is too new.
- A Google Play Console developer account (🧑 HUMAN).

## 2. Version

The web `package.json` version is the app version. Set it, then copy it into the Android project:

```bash
node scripts/sync-native-version.mjs
```

This writes `versionName` and `versionCode`. The version code is `major·10000 + minor·100 + patch` (0.4.0 → 400), so it grows with every
release; minor and patch must stay below 100 and `0.0.0` is refused. A unit test fails while the
Android project is out of sync (`node scripts/sync-native-version.mjs --check`).

## 3. OAuth client ids for the Android app (🧑 HUMAN)

The build reads the public client ids from `apps/web/.env.local` (template: `.env.example`). The
Android app needs these registrations in addition to the web ones:

- **Microsoft Entra** (same app as the web): add the platform "Mobile and desktop applications"
  with the redirect URI `com.astats.budget://auth/callback/microsoft`. `VITE_MS_CLIENT_ID` is
  shared.
- **Google Cloud**: create an OAuth client of type **Android** (package `com.astats.budget`, the
  SHA-1 of the signing certificate; with Play App Signing use the app-signing key's SHA-1 from the
  Play Console) and under _Advanced settings_ turn on **Enable custom URI scheme** (its redirect is
  `com.astats.budget:/oauth2redirect`) → `VITE_GOOGLE_ANDROID_CLIENT_ID`.
- **Dropbox** (same app): add the redirect URI `com.astats.budget://auth/callback/dropbox`.
  `VITE_DROPBOX_APP_KEY` is shared.

Then test each provider on a device: connect → back up → list → restore → disconnect.

## 4. Upload keystore (🧑 HUMAN, once)

Create the upload key **outside the repository** and keep a backup of it and its password in a
password manager. Losing it means asking Google to reset the upload key.

```bash
keytool -genkeypair -keystore ~/.budget-app/upload.jks -storetype PKCS12 -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Budget upload key"
```

Create `~/.budget-app/keystore.properties` (or another path, given in the environment variable
`BUDGET_KEYSTORE_PROPERTIES`):

```properties
storeFile=C:/Users/<you>/.budget-app/upload.jks
storePassword=<store password>
keyAlias=upload
keyPassword=<key password>
```

`android/app/build.gradle` signs release builds with it when the file exists; otherwise release
builds are unsigned. `*.jks`, `*.keystore` and `keystore.properties` are git-ignored; never commit
them. Enroll in Play App Signing when creating the app in the Play Console, so Google holds the
app-signing key and this key only signs uploads.

## 5. Build

```bash
pnpm build
npx cap sync android
cd android
./gradlew bundleRelease        # PowerShell: .\gradlew.bat bundleRelease
```

The signed bundle is `android/app/build/outputs/bundle/release/app-release.aab`; upload it to the
Play Console. `./gradlew assembleRelease` builds an installable APK
(`app/build/outputs/apk/release/app-release.apk`) for testing on a device.

Release builds are minified and resource-shrunk with R8 (`minifyEnabled`, `shrinkResources`), never
debuggable, ship no source maps (`scripts/verify-build.mjs`) and keep WebView debugging and native
logging off (SEC-M08). The R8 rules for SQLCipher and Tink are in `android/app/proguard-rules.pro`;
keep R8's mapping file (`app/build/outputs/mapping/release/mapping.txt`) with each release to read
crash stack traces.

## 6. Check before uploading

```bash
"$ANDROID_HOME/build-tools/<version>/apksigner" verify --print-certs app/build/outputs/apk/release/app-release.apk
"$JAVA_HOME/bin/jarsigner" -verify app/build/outputs/bundle/release/app-release.aab
```

Then install the APK on a device or emulator and run the manual checklist in TEST_PLAN §8.3
(install, onboarding, biometric unlock, background lock, CSV share/import, OAuth deep links,
upgrade from the previous version with data kept, SEC-M09).

## 7. Icons and splash screens

`node scripts/generate-icons.mjs` (also `pnpm --filter web icons`) draws every icon from one design
(teal square, three white ledger lines) without extra dependencies: the PWA icons, the Android
launcher icons (legacy, round and the adaptive-icon foreground on `#0F766E`), and the Android
splash images. Android 12 and newer show the
adaptive icon on the teal `windowSplashScreenBackground` instead of the splash image.
