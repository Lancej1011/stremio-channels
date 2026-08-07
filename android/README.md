# Headend for Android

This is a native Android viewer built with Media3. It loads the Headend guide, asks the
authenticated tune endpoint for the program currently on air, seeks a compatible source
to its wall-clock position, and automatically retunes at the next program boundary. If
the phone cannot decode the source—or direct playback fails—it switches to Headend HLS.

## Install the debug build

The ready-to-install APK is at `app/build/outputs/apk/debug/app-debug.apk`. Enable USB
debugging on the phone, connect it, then run:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Open **Headend** and paste the private Watch URL shown by the server, including the access
token when one is configured. Examples:

```text
http://192.168.1.20:7654/watch
https://channels.example.ts.net/<token>/watch
```

For away-from-home playback, the HTTPS Tailscale Serve/Funnel address must be reachable
from the phone. Direct mode saves the server from transcoding but the phone still streams
the selected video from the resolved provider URL; HLS remains the compatibility fallback.

## Build

Set the Android SDK location and use the checked-in wrapper:

```bash
export ANDROID_HOME=/path/to/Android/Sdk
./gradlew testDebugUnitTest assembleDebug
```

The app requires Android 8.0 (API 26) or newer. Casting and picture-in-picture are planned,
not part of this first build.
