# RepLock / PushToUnlock54

RepLock is an Android discipline app that blocks distracting apps and requires a push-up challenge before access is restored.

The core product idea is simple: choose apps that waste attention, such as TikTok, Instagram, YouTube, games, or any installed Android app, and RepLock turns opening them into a short physical challenge.

## Project Overview

RepLock is built as an Expo SDK 54 React Native app with custom native Android Kotlin code. The React Native app owns the product UI, settings, challenge screens, local statistics, and user configuration. Native Android code owns app detection, challenge redirection, package launching, protected-app syncing, and temporary unlock sessions.

This project is Android-first and currently targets Expo Dev Builds, not Expo Go, because real app blocking requires Android native services and permissions.

## Core Idea

1. The user selects distracting apps to protect.
2. Android detects when one of those apps opens.
3. RepLock redirects the user into a push-up challenge.
4. The user completes the required reps.
5. RepLock grants a temporary unlock session.
6. The target app opens automatically.
7. When the unlock session expires, the app is locked again.

## Current Features

- Android app blocking flow
- `AccessibilityService` foreground-app detection
- Redirect-to-challenge flow when a protected app opens
- Manual push-up challenge counter
- Configurable required push-ups per unlock
- Configurable unlock duration
- Installed Android app picker
- Protected app selection synced to native Android storage
- Temporary per-package unlock sessions
- Native Kotlin bridge for detection, unlock, app launch, and debug data
- Local statistics and progress history
- Detection Debug screen for native blocker state
- Expo Dev Client / EAS Build support
- Experimental native camera pose screen prototype

## Tech Stack

- React Native
- Expo SDK 54
- Expo Dev Client
- JavaScript
- Native Android Kotlin
- Android `AccessibilityService`
- Android `PackageManager`
- Android `SharedPreferences`
- AsyncStorage
- EAS Build
- CameraX + ML Kit Pose Detection prototype for future camera challenges

## Architecture

### React Native Responsibilities

- Home, Settings, Locked Apps, Challenge, Success, Progress, and Detection Debug screens
- Manual push-up counter
- Local settings with AsyncStorage
- Local progress/statistics
- Installed-app selection UI
- Unlock duration selection
- Required push-up count selection
- Calling native methods such as `unlockApp`, `setProtectedApps`, and app/debug queries
- Optional camera challenge entry point and prototype status UI

### Native Android Kotlin Responsibilities

- Detecting foreground apps through `RepLockAccessibilityService`
- Reading selected protected package names from native storage
- Redirecting locked app opens into the RepLock challenge screen
- Storing unlock sessions per package name
- Applying short post-unlock grace periods to avoid immediate re-blocks
- Launching target apps through `PackageManager.getLaunchIntentForPackage`
- Returning installed launchable apps to React Native
- Returning detection/debug state to React Native
- Providing the experimental native camera pose view

## How The Blocker Flow Works

1. The user selects protected apps in Settings.
2. React Native saves the selection locally and syncs selected package names to Kotlin.
3. The Accessibility Service watches `TYPE_WINDOW_STATE_CHANGED` events.
4. If the foreground package is not protected, RepLock ignores it.
5. If the package is protected and currently unlocked, RepLock allows it.
6. If the package is protected and locked, RepLock opens:

   ```text
   pushtounlock54://challenge?packageName=...&appName=...
   ```

7. React Native opens the challenge screen for that app.
8. Completing the challenge calls native `unlockApp(packageName, durationMs)`.
9. Kotlin stores `unlockedUntil` for that package.
10. Kotlin launches the target app.
11. During the unlock window, the app opens freely.
12. After expiration, opening the app triggers RepLock again.

## Required Android Permissions

### Accessibility Permission

Required for app detection. RepLock uses an Android `AccessibilityService` to detect when a selected protected app becomes foreground.

Users must enable this manually in Android Accessibility Settings.

### Display Over Other Apps / Overlay Permission

The project includes overlay permission support from earlier blocker prototypes. The current preferred flow redirects immediately into the RepLock challenge screen, so long-lived overlays are not the primary blocking mechanism.

Overlay permission may still be useful for future blocker surfaces or transition screens.

### Camera Permission

Required only for the experimental camera challenge prototype. The stable unlock flow still works with the manual counter.

## Installation And Development Setup

Install dependencies:

```bash
npm install
```

Start the Expo Dev Client server:

```bash
npx expo start --dev-client -c
```

Create an Android development build:

```bash
eas build -p android --profile development
```

This project uses native Android code, so Expo Go is not enough for the blocker flow. Use an Expo Dev Build installed on an Android device.


## Testing Checklist

### Setup

- Install the Android development build.
- Open RepLock.
- Enable App Protection in Android Accessibility Settings.
- Enable overlay permission if testing overlay-related behavior.
- Select one or more protected apps in Settings.
- Choose required push-ups per unlock.
- Choose unlock duration.

### Blocker Flow

- Open a protected app such as TikTok, Instagram, YouTube, or another selected app.
- Confirm RepLock opens the challenge screen automatically.
- Press Back before completing the challenge.
- Confirm the app remains locked.
- Open the protected app again.
- Confirm RepLock redirects to challenge again.
- Complete the manual push-up counter.
- Confirm the target app opens automatically.
- Reopen the app during the unlock window.
- Confirm no challenge appears.
- Wait for the unlock duration to expire.
- Open the app again.
- Confirm RepLock challenges again.

### Debugging

- Open Detection Debug.
- Confirm selected protected package names are shown.
- Confirm last detected package updates.
- Confirm last blocked package and launch result are visible.
- Confirm remaining unlock time updates after a successful challenge.

### Camera Prototype

- Start a challenge.
- Tap Camera Challenge.
- Grant camera permission.
- Confirm live camera preview opens.
- Confirm pose skeleton/status appears when the body is visible.
- Use manual counter fallback for actual unlocking.

## Current Limitations

- Android only.
- Requires Expo Dev Build because native Kotlin code is required.
- Accessibility permission must be enabled manually by the user.
- Android does not allow RepLock to directly pause or mute another app; the current strategy redirects the user into RepLock so the target app naturally moves to the background.
- Manual push-up counting is the stable unlock mechanism.
- Camera-based pose tracking is experimental and not yet the production unlock counter.
- No backend or account sync.
- No production anti-cheat yet.
- App blocking depends on Android accessibility events and OEM behavior, which can vary by device.

## Roadmap

- Production camera-based push-up detection
- Real-time pose estimation skeleton tracking improvements
- Automatic push-up counting with UP/DOWN state detection
- Anti-cheat checks
- Confidence scoring and calibration
- Low-light and framing guidance
- Knee push-up support
- Better permission onboarding
- Better locked-app onboarding
- Production release hardening
- Play Store readiness

## Status

RepLock currently has a working Android blocker MVP:

- protected app detection works,
- challenge redirection works,
- manual unlock works,
- temporary unlock sessions work,
- app picker and unlock duration settings work,
- native debug visibility exists,
- camera pose work is in prototype stage.

