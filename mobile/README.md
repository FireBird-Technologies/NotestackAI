# Notestack mobile

The iOS and Android app, built with Expo (SDK 58) and expo-router. It shares its API client and types with the web app
through `@notestack/shared` (`../packages/shared`), linked as a `file:` dependency.

## Run it

1. `cp .env.example .env` and set `EXPO_PUBLIC_API_URL` to your Mac's LAN IP (`ipconfig getifaddr en0`), port 8000.
   Start the API on `0.0.0.0:8000` so phones can reach it.
2. `npm install`
3. iOS Simulator: `npm run ios`. A connected iPhone: `npx expo run:ios --device`. Android: `npm run android`.
4. After the first build, `npm start` serves JavaScript changes to the installed app.

Rebuild (`npm run ios` again) after adding a native package or changing `app.config.ts`.

## Variants

`APP_VARIANT` picks the variant in `app.config.ts`:

| Variant | App name | Bundle ID / package |
| --- | --- | --- |
| development (default) | Notestack Dev | `ai.notestack.app` |
| production | Notestack | `ai.notestack.app` |

Both variants share one id, because Google and Apple sign in are registered for it, so the dev build replaces a
store install on the same device. Only the development variant allows plain HTTP, for the local API.

## Guest mode (iOS)

`modules/device-check` is a local native module: run `npx pod-install` (or `npx expo prebuild`) after pulling it. The
simulator has no DeviceCheck, so there the server goes by the device id alone. On the server, set
`DEVICECHECK_KEY_ID` and `DEVICECHECK_PRIVATE_KEY` (a key with DeviceCheck turned on, of the team in `APPLE_TEAM_ID`);
`DEVICECHECK_DEVELOPMENT=true` for builds run from Xcode. `GUEST_MODE_ENABLED=false` turns guests off, and raising
`GUEST_EPOCH` (1 to 3) gives every device one more free allowance, so it can only be done twice.

## Checks

`npm run typecheck` and `npx eslint src`.
