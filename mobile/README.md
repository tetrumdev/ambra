# Ambra mobile

`bun run start` starts the Expo development server. The player and pairing screens work in Expo Go.

The app sits on true black (#000) for OLED screens. Swipe down on the fullscreen player (or tap its grab handle) to reach MEGA, and swipe up on the mini-player (or tap it) to return. MEGA uses the server's saved songs and order, with desktop's Play and Shuffle; bound song groups stay together when shuffled. Tap a song to play from it, or hold it (or tap its options) for desktop's playback menu: Standalone Play, Play from Here, Play Next and Add to Queue. Pull to refresh the playlist.

The queue button on either player opens the shared queue. Tap an upcoming song to play from it, hold it to play from here or remove it, or clear upcoming songs. Sheets drag down to close, and every control answers with a haptic.

Tap the output pill at the fullscreen player's bottom left to choose an output on any online device, including this phone. The phone registers with the same server output protocol as desktop, resumes at the current position, and plays through its current system audio route (speaker, headphones or Bluetooth). Switching away releases phone audio. Phone lock-screen pause/play and seeks follow the shared session; the server advances the queue after a song ends. Files that exist only at a computer's private path must be imported into the server library before the phone can stream them.

Foreground phone playback works in Expo Go. Rebuild the native app after this change for sustained background playback: the audio plugin now enables the Android playback service and iOS audio background mode. Android also uses native lock-screen playback controls to keep playback active in the background.

## Away from home (Tailscale)

With Tailscale on the phone and the server's computer, pair using the computer's Tailscale name (e.g. `ewphpc`) or its `100.x` address and it works on any network. A phone paired on home Wi-Fi also follows the server away from home: when its address stops answering, the app tries every address the server has answered at and its MagicDNS name (the machine name, lowercased), and switches to the first one where the same server (by ID) answers. Plain HTTP is allowed to Tailscale (`*.ts.net` on iOS; all cleartext on Android, which the LAN server needs too), so rebuild the native app after this change.

## iPhone Live Activity

A native build adds the current song, artwork, progress, playback state and output name to the Lock Screen and Dynamic Island. Tapping it opens Ambra. It uses ActivityKit on the app's supported iOS versions (16.4 and later); Dynamic Island appears on devices with that hardware. Android continues to use the normal app.

When another device is the output, the app loops a bundled, zero-sample WAV in a mixing background audio session while the Live Activity is active. This is a background-execution workaround for following the LAN server while the phone is locked. It does not register MediaPlayer/headset commands or forward silent-player interruptions to the server. Other apps' audio can continue. The silent lease is released when this phone becomes the output, allowing actual playback and native lock-screen controls to own the audio session. The remote-only workaround uses additional battery and remains subject to iOS background execution and interruption rules; it needs testing on a real iPhone and may not be suitable for App Store distribution.

Unpairing, losing the output, stale server state, or dismissing the activity releases the background player. Returning to Ambra refreshes the server state. The Live Activity uses only local app-group storage; it needs no internet relay, push server, or microphone permission.

Expo Go cannot load the Live Activity extension. Create a development build after installing dependencies, using EAS on Windows or `bunx expo run:ios` on a Mac. Native changes require rebuilding the app; Fast Refresh alone cannot add the extension or background capability. The Expo Widgets plugin creates the extension and app-group configuration during prebuild; do not edit generated `ios/` files.

Validation:

```
bun run lint
bunx tsc --noEmit
bun test --cwd ../desktop tests/activitySession.test.ts tests/mobileClient.test.ts tests/mobileQueue.test.ts tests/phonePlayback.test.ts
```
