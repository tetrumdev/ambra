import { useEffect, useState, useSyncExternalStore } from "react";
import { createAudioPlayer } from "expo-audio";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { configureAudioSession } from "./audioSession";
import { LocalMusic } from "./localLibrary";
import { importLocalFiles, loadLocalLibrary, saveLocalLibrary, removeLocalFile } from "./localFiles";
import { Touchable } from "./Touchable";
import { colors, fonts } from "./theme";

let closing: Promise<void> = Promise.resolve();

export function LocalLibraryScreen() {
  const [music, setMusic] = useState<LocalMusic | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let controller: LocalMusic | null = null;
    void closing.then(loadLocalLibrary).then(library => {
      if (disposed) return;
      controller = new LocalMusic(library, {
        save: saveLocalLibrary, activate: () => configureAudioSession(true),
        create: source => createAudioPlayer(source, { updateInterval: 250, keepAudioSessionActive: true, allowsExternalPlayback: false }),
      });
      setMusic(controller);
    }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; if (controller) closing = controller.release().catch(() => {}); };
  }, []);
  if (!music) return <View style={styles.screen}><Text style={styles.body}>{error ?? "Loading local music…"}</Text></View>;
  return <LocalLibraryView music={music} />;
}
function Button({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Touchable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress} style={styles.button}><Text style={styles.buttonText}>{title}</Text></Touchable>;
}
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
function LocalLibraryView({ music }: { music: LocalMusic }) {
  const view = useSyncExternalStore(music.subscribe, music.snapshot);
  const { library } = view;
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const insets = useSafeAreaInsets();
  const playlist = library.playlists.find(item => item.id === playlistId);
  const ids = playlist?.trackIds ?? library.tracks.map(track => track.id);
  const tracks = ids.flatMap(id => library.tracks.find(track => track.id === id) ?? []);
  const run = (operation: Promise<unknown>) => { void operation.catch(reason => setError(String(reason))); };
  const edit = (operation: Parameters<LocalMusic["edit"]>[0]) => run(music.edit(operation));
  const current = music.track();
  return <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Local music</Text>
      <Text style={styles.body}>Files, playlists, queue, and history stay on this phone. No server required.</Text>
      <Button title={busy ? "Importing…" : "Import music files"} disabled={busy} onPress={() => {
        setBusy(true); setError(null);
        void importLocalFiles().then(tracks => music.edit(state => ({ ...state, tracks: [...state.tracks, ...tracks] })))
          .catch(reason => setError(String(reason))).finally(() => setBusy(false));
      }} />
      {(error || view.error) && <Text accessibilityRole="alert" style={styles.error}>{error ?? view.error}</Text>}
      <Text style={styles.heading}>Playlists</Text>
      <View style={styles.row}><TextInput accessibilityLabel="Playlist name" placeholder="Playlist name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} style={styles.input} />
        <Button title="Create" disabled={!name.trim()} onPress={() => {
          const id = `playlist-${Date.now()}`;
          edit(state => ({ ...state, playlists: [...state.playlists, { id, name: name.trim(), trackIds: [] }] })); setName(""); setPlaylistId(id);
        }} /></View>
      <View style={styles.row}><Button title="All music" onPress={() => setPlaylistId(null)} />
        {library.playlists.map(item => <Button key={item.id} title={item.name} onPress={() => setPlaylistId(item.id)} />)}</View>
      {playlist && <>
        <Text style={styles.heading}>{playlist.name}</Text>
        <View style={styles.row}><Button title="Rename" disabled={!name.trim()} onPress={() => { edit(state => ({ ...state, playlists: state.playlists.map(item => item.id === playlistId ? { ...item, name: name.trim() } : item) })); setName(""); }} />
          <Button title="Delete playlist" onPress={() => { edit(state => ({ ...state, playlists: state.playlists.filter(item => item.id !== playlistId) })); setPlaylistId(null); }} /></View>
      </>}
      {!library.tracks.length && <Text style={styles.body}>Import audio files from Files to begin. Codec support depends on your phone.</Text>}
      {tracks.map(track => <View key={track.id} style={styles.track}>
        <Touchable accessibilityRole="button" accessibilityLabel={`Play ${track.name}`} onPress={() => run(music.play(track.id, ids))}><Text style={styles.song}>{track.name}</Text><Text style={styles.body}>{track.artist}</Text></Touchable>
        <View style={styles.row}><Button title="Queue" onPress={() => edit(state => ({ ...state, queue: [...state.queue, track.id] }))} />
          <Button title="Play next" onPress={() => edit(state => ({ ...state, queue: [...state.queue.slice(0, state.index + 1), track.id, ...state.queue.slice(state.index + 1)] }))} />
          <Button title="Remove local file" onPress={() => Alert.alert("Remove local file?", "This removes Ambra’s imported copy and playlist references. The original file stays in Files.", [
            { text: "Cancel", style: "cancel" },
            { text: "Remove", style: "destructive", onPress: () => run(music.removeTrack(track.id).then(() => removeLocalFile(track))) },
          ])} />
          {playlist && <Button title="Remove" onPress={() => edit(state => ({ ...state, playlists: state.playlists.map(item => item.id === playlistId ? { ...item, trackIds: item.trackIds.filter(id => id !== track.id) } : item) }))} />}</View>
      </View>)}
      {playlist && library.tracks.filter(track => !ids.includes(track.id)).map(track => <View key={track.id} style={styles.row}><Text style={styles.song}>{track.name}</Text><Button title="Add" onPress={() => edit(state => ({ ...state, playlists: state.playlists.map(item => item.id === playlistId ? { ...item, trackIds: [...item.trackIds, track.id] } : item) }))} /></View>)}
      <Button title={showQueue ? "Hide queue" : `Show queue (${library.queue.length})`} onPress={() => setShowQueue(value => !value)} />
      {showQueue && library.queue.map((id, index) => <View style={styles.row} key={`${index}-${id}`}><Text style={styles.body}>{index === library.index ? "Playing: " : ""}{library.tracks.find(track => track.id === id)?.name}</Text>
        {index > library.index && <Button title="Remove queued song" onPress={() => edit(state => ({ ...state, queue: state.queue.filter((_, at) => at !== index) }))} />}</View>)}
      <Text style={styles.heading}>Recently played</Text>
      {[...library.history].reverse().slice(0, 20).map((entry, index) => <Text key={`${entry.playedAt}-${index}`} style={styles.body}>{library.tracks.find(track => track.id === entry.trackId)?.name}</Text>)}
    </ScrollView>
    {current && <View style={styles.player}>
      <Text numberOfLines={1} style={styles.song}>{current.name}</Text>
      <Text style={styles.body}>{time(view.position)} / {time(view.duration)}{view.buffering ? " · Loading…" : ""}</Text>
      <View style={styles.row}>
        <Button title="Previous" onPress={() => run(music.command("previous"))} />
        <Button title={view.playing ? "Pause" : "Play"} onPress={() => run(music.command("toggle"))} />
        <Button title="Next" onPress={() => run(music.command("next"))} />
        <Button title="Back 10s" onPress={() => run(music.command("seek", { positionSeconds: view.position - 10 }))} />
        <Button title="Forward 10s" onPress={() => run(music.command("seek", { positionSeconds: view.position + 10 }))} />
        <Button title="Volume −" onPress={() => run(music.command("volume", { volume: library.volume - 10 }))} />
        <Button title={`Volume + (${library.volume}%)`} onPress={() => run(music.command("volume", { volume: library.volume + 10 }))} />
      </View>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black }, content: { padding: 24, gap: 14 },
  title: { fontFamily: fonts.serif, fontSize: 36, color: "white" }, heading: { fontFamily: fonts.sans, color: "white", fontSize: 20 },
  body: { fontFamily: fonts.sans, color: colors.secondary, fontSize: 14 }, song: { fontFamily: fonts.sans, color: "white", fontSize: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }, track: { paddingVertical: 10, gap: 8 },
  button: { backgroundColor: colors.raised, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16 }, buttonText: { color: "white", fontFamily: fonts.sans },
  input: { color: "white", backgroundColor: colors.raised, padding: 12, borderRadius: 16, flex: 1 },
  error: { color: colors.error }, player: { padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: colors.raised },
});
