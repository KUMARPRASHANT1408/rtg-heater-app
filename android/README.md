# RTG Heater Management Android app

A small Android app that opens the live website full screen. Website changes reach it by themselves,
so a new APK is needed only when this folder changes.

GitHub builds the APK (`.github/workflows/android-apk.yml`) whenever something under `android/` changes
on `main`, and puts `RTG-Heater-Management.apk` on the repository's **Releases** page.

## Releasing a new APK

1. In `app/build.gradle`, raise `versionCode` by 1 and set a new `versionName`.
2. Put the same numbers in `docs/app-version.json`. The app then shows "New app version" to everyone.

## Keeping one signing key (recommended)

Android installs an update over the old app only when both were signed with the same key.
Without a saved key every build gets a new temporary one, so phones must uninstall the old app first.
To keep one key, add these three repository secrets (Settings → Secrets and variables → Actions):

- `RTG_KEYSTORE_BASE64`: the keystore file, base64 encoded
- `RTG_KEYSTORE_PASSWORD`: its password
- `RTG_KEY_ALIAS`: the key alias

Never commit the keystore or its password to this public repository.
