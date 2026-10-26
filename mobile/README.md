# Ambra mobile

`bun run start` starts the Expo development server. The player and pairing screens work in Expo Go.

## iPhone Live Activity

A native build adds the current song, artwork, progress, playback state and output name to the Lock Screen and Dynamic Island. Tapping it opens Ambra. It uses ActivityKit on the app's supported iOS versions (16.4 and later); Dynamic Island appears on devices with that hardware. Android continues to use the normal app.

The app loops a bundled, zero-sample WAV in a mixing background audio session while the Live Activity is active. This is a background-execution workaround for following the LAN server while the phone is locked. It does not register MediaPlayer/headset commands or forward silent-player interruptions to the server. Other apps' audio can continue. This workaround uses additional battery and remains subject to iOS background execution and interruption rules; it needs testing on a real iPhone and may not be suitable for App Store distribution.

Unpairing, losing the output, stale server state, or dismissing the activity releases the background player. Returning to Ambra refreshes the server state. The Live Activity uses only local app-group storage; it needs no internet relay, push server, or microphone permission.

Expo Go cannot load the Live Activity extension. Create a development build after installing dependencies, using EAS on Windows or `bunx expo run:ios` on a Mac. Native changes require rebuilding the app; Fast Refresh alone cannot add the extension or background capability. The Expo Widgets plugin creates the extension and app-group configuration during prebuild; do not edit generated `ios/` files.

Validation:

```
bun run lint
bunx tsc --noEmit
bun test --cwd ../desktop tests/activitySession.test.ts
```
