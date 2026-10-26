import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { Directory, File } from "expo-file-system";
import { widgetsDirectory } from "expo-widgets";
import { AppState } from "react-native";
import { ActivitySession, activitySnapshot } from "./activitySession";
import { currentTrack, sessionView, sessionViewAge, subscribe } from "./client";
import NowPlayingActivity from "./NowPlayingActivity.ios";

/** A silent, mixing background lease. It never owns Now Playing or forwards audio/headset events. */
function backgroundLease() {
  let player: AudioPlayer | null = null;
  return async (active: boolean) => {
    if (!active) {
      player?.remove();
      player = null;
      return;
    }
    if (player) {
      // iOS can pause the silent lease on a route change. Resume it when the user
      // returns, without fighting background interruptions or touching server playback.
      if (AppState.currentState === "active" && !player.playing) player.play();
      return;
    }
    await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: "mixWithOthers", allowsRecording: false });
    player = createAudioPlayer(require("../assets/silence.wav"), { updateInterval: 1000, allowsExternalPlayback: false });
    player.loop = true;
    player.volume = 0;
    player.play();
  };
}

/** Start once per paired app session. A native build is required; Expo Go never loads this module. */
export function followLiveActivity() {
  const session = new ActivitySession({
    recover: () => NowPlayingActivity.getInstances(),
    start: (props, url, stale) => NowPlayingActivity.start(props, url, stale),
    foreground: () => AppState.currentState === "active",
    keepAlive: backgroundLease(),
    isActive: activity => NowPlayingActivity.getInstances().some(item => item.getId() === activity.getId?.()),
  });
  let stopped = false;
  let artworkSource = "";
  let artworkPath = "";
  let artworkFile: File | null = null;
  let artworkVersion = 0;
  let warned = false;
  const sync = () => {
    const view = sessionView();
    const props = stopped ? null : activitySnapshot(view, sessionViewAge(), Date.now());
    const source = props ? currentTrack(view)?.cover ?? "" : "";
    if (source !== artworkSource) {
      artworkSource = source;
      artworkPath = "";
      const version = ++artworkVersion;
      if (source && widgetsDirectory) {
        try {
          const directory = new Directory(widgetsDirectory, "ambra-covers");
          directory.create({ idempotent: true, intermediates: true });
          const file = new File(directory, `cover-${Date.now()}-${version}.jpg`);
          void File.downloadFileAsync(source, file, { idempotent: true }).then(download => {
            if (stopped || version !== artworkVersion) { download.delete(); return; }
            const previous = artworkFile;
            artworkFile = download;
            artworkPath = download.uri;
            sync();
            if (previous?.exists) previous.delete();
          }).catch(() => { /* A music-note fallback still shows the current song. */ });
        } catch { /* A missing shared container must not affect playback. */ }
      }
    }
    if (props) props.artwork = artworkPath;
    void session.sync(props).catch(error => {
      if (!warned) console.warn("Could not update the Live Activity:", error);
      warned = true;
    });
  };
  const unsubscribe = subscribe(sync);
  const state = AppState.addEventListener("change", next => { if (next === "active") sync(); });
  const timer = setInterval(sync, 30_000);
  sync();
  return () => {
    stopped = true;
    artworkVersion++;
    unsubscribe();
    state.remove();
    clearInterval(timer);
    void session.sync(null).then(() => { if (artworkFile?.exists) artworkFile.delete(); }).catch(() => {});
  };
}
