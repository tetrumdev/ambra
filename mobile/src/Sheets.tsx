import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Track } from "../../desktop/src/types/music";
import { musicProviderName } from "../../desktop/src/utils/musicProviderName";
import { clientId } from "./client";
import { downloadClients, downloadQualities, isDownloadable, requestDownloads, useDownloads, type DownloadClient, type DownloadQuality } from "./downloads";
import { Icon } from "./Icons";
import { addToPlaylist, addToServicePlaylist, createPlaylist, trackCredits, useLibrary, type CreditGroup } from "./library";
import { reason, showToast } from "./navigation";
import { services } from "./servicePreferences";
import { Sheet } from "./Sheet";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";

type DownloadRequest = { tracks: Track[]; title: string };
let downloadRequest: DownloadRequest | null = null;
const downloadListeners = new Set<() => void>();
const setDownloadRequest = (next: DownloadRequest | null) => { downloadRequest = next; for (const listener of downloadListeners) listener(); };

/** Opens the download menu for these songs, as every desktop Download action does. */
export function openDownloadSheet(tracks: Track[], title: string) {
  const unique = new Map(tracks.filter(track => isDownloadable(track.globalId)).map(track => [track.globalId, track]));
  setDownloadRequest({ tracks: [...unique.values()], title });
}

const songs = (count: number) => `${count} ${count === 1 ? "song" : "songs"}`;

/** Download to Server or to Client, at the chosen quality (`desktop/src/components/DownloadDialog.tsx`). */
export function DownloadSheetHost() {
  const request = useSyncExternalStore(listener => { downloadListeners.add(listener); return () => { downloadListeners.delete(listener); }; }, () => downloadRequest);
  if (!request) return null;
  return <DownloadSheet key={request.title + request.tracks.length} request={request} onClose={() => setDownloadRequest(null)} />;
}

function DownloadSheet({ request, onClose }: { request: DownloadRequest; onClose: () => void }) {
  const { jobs } = useDownloads();
  const [step, setStep] = useState<"target" | "clients" | "started">("target");
  const [quality, setQuality] = useState<DownloadQuality>("max");
  const [clients, setClients] = useState<DownloadClient[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [self, setSelf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number[]>([]);
  useEffect(() => { void clientId().then(setSelf); }, []);
  useEffect(() => {
    if (step !== "clients") return;
    const abort = new AbortController();
    const refresh = () => void downloadClients(abort.signal).then(list => {
      setClients(list);
      setChosen(current => new Set([...current].filter(id => list.some(client => client.id === id))));
    }).catch(failure => { if (!abort.signal.aborted) setError(reason(failure, "Couldn't find open apps.")); });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [step]);

  const start = async (target: Parameters<typeof requestDownloads>[2]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await requestDownloads(request.tracks, quality, target);
      haptic.success();
      setStarted(created.map(job => job.id));
      setStep("started");
    } catch (failure) {
      haptic.error();
      setError(reason(failure, "Couldn't start the download."));
    } finally { setBusy(false); }
  };
  const progress = jobs.filter(job => started.includes(job.id));
  return (
    <Sheet label={`Download ${request.title}`} onClose={onClose} grip={<View style={styles.heading}>
      <Text style={styles.title} numberOfLines={2}>Download {request.title}</Text>
      <Text style={styles.detail}>{songs(request.tracks.length)}</Text>
    </View>}>
      {close => <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {request.tracks.length === 0 ? <Text style={styles.error}>None of these songs can be downloaded. Only songs from a streaming service can.</Text>
          : step === "started" ? <>
            {progress.length === 0 && <Text style={styles.detail}>Download started.</Text>}
            {progress.map(job => <View key={job.id} style={styles.job}>
              <Text style={styles.label}>{job.target === "server" ? "Server" : job.targetName}</Text>
              <Text style={styles.detail}>{job.finished ? job.failed ? `${job.done} downloaded, ${job.failed} failed` : "Done" : `${job.done + job.failed} of ${job.total}`}</Text>
              {job.error && <Text style={styles.error}>{job.error}</Text>}
            </View>)}
            <Touchable accessibilityRole="button" onPress={close} style={styles.primary}><Text style={styles.primaryText}>Done</Text></Touchable>
          </> : <>
            <Text style={styles.section}>Quality</Text>
            {downloadQualities.map(option => <Touchable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: quality === option.id }} highlight haptic="select" onPress={() => setQuality(option.id)} style={styles.option}>
              <Text style={[styles.label, quality === option.id && styles.selected]}>{option.label}</Text>
              {quality === option.id && <Icon name="check" size={14} />}
            </Touchable>)}
            {step === "target" ? <>
              <Text style={styles.section}>Download to</Text>
              <Touchable accessibilityRole="button" highlight disabled={busy} onPress={() => void start({ kind: "server" })} style={styles.option}>
                <Icon name="download" size={18} /><Text style={styles.label}>Download to Server</Text>
              </Touchable>
              <Touchable accessibilityRole="button" highlight disabled={busy} onPress={() => { setError(null); setStep("clients"); }} style={styles.option}>
                <Icon name="download" size={18} /><Text style={styles.label}>Download to Client</Text>
              </Touchable>
            </> : <>
              <Touchable accessibilityRole="button" haptic="tap" onPress={() => setStep("target")} style={styles.backRow}><Icon name="back" size={14} color={colors.secondary} /><Text style={styles.detail}>Back</Text></Touchable>
              <Text style={styles.section}>Download to</Text>
              {clients === null && <ActivityIndicator color={colors.muted} style={styles.loading} />}
              {clients?.length === 0 && <Text style={styles.detail}>No apps are open on this server.</Text>}
              {clients?.map(client => <Touchable key={client.id} accessibilityRole="checkbox" accessibilityState={{ checked: chosen.has(client.id) }} highlight haptic="select"
                onPress={() => setChosen(current => { const next = new Set(current); if (next.has(client.id)) next.delete(client.id); else next.add(client.id); return next; })} style={styles.option}>
                <View style={[styles.box, chosen.has(client.id) && styles.boxChecked]}>{chosen.has(client.id) && <Icon name="check" size={12} color="black" />}</View>
                <Text style={styles.label}>{client.name}{client.id === self ? " (this phone)" : ""}</Text>
              </Touchable>)}
              <Touchable accessibilityRole="button" disabled={busy || chosen.size === 0} haptic="firm" onPress={() => void start({ kind: "clients", clientIds: [...chosen] })} style={styles.primary}>
                <Text style={styles.primaryText}>{busy ? "Starting…" : "Download"}</Text>
              </Touchable>
            </>}
          </>}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      </ScrollView>}
    </Sheet>
  );
}

/** Desktop's Add to Playlist submenu: AMBRA playlists, editable service playlists, or a new one. */
export function PlaylistPicker({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const library = useLibrary();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const add = (work: () => Promise<unknown>, playlist: string) => {
    if (busy) return;
    setBusy(true);
    void work().then(() => { haptic.success(); showToast(`Added to ${playlist}`); onClose(); })
      .catch(failure => { haptic.error(); showToast(reason(failure, "Couldn't save this playlist."), true); })
      .finally(() => setBusy(false));
  };
  const single = tracks.length === 1 ? tracks[0] : null;
  return (
    <Sheet label="Add to Playlist" tall onClose={onClose} grip={<View style={styles.heading}><Text style={styles.title}>Add to Playlist</Text></View>}>
      {() => <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
        <View style={styles.create}>
          <TextInput value={name} onChangeText={setName} placeholder="New playlist" placeholderTextColor={colors.faint} keyboardAppearance="dark" style={styles.input} accessibilityLabel="New AMBRA playlist name" />
          <Touchable accessibilityRole="button" disabled={!name.trim() || busy} onPress={() => add(() => createPlaylist(name, tracks), name.trim())} style={styles.createButton}><Text style={styles.primaryText}>Create</Text></Touchable>
        </View>
        <Text style={styles.section}>AMBRA</Text>
        {library.playlists.length === 0 && <Text style={styles.detail}>No playlists yet. Create one above.</Text>}
        {library.playlists.map(playlist => {
          const added = !!single && playlist.trackIds.includes(single.globalId);
          return <Touchable key={playlist.id} accessibilityRole="button" highlight disabled={added || busy} onPress={() => add(() => addToPlaylist(playlist.id, tracks), playlist.name)} style={styles.option}>
            <Text style={styles.label} numberOfLines={1}>{playlist.name}{added ? "  ✓" : ""}</Text>
          </Touchable>;
        })}
        {single && services.map(service => {
          const editable = library.servicePlaylists[service].filter(playlist => playlist.editable);
          if (!editable.length || single.provider !== service) return null;
          return <View key={service}>
            <Text style={styles.section}>{musicProviderName(service)}</Text>
            {editable.map(playlist => <Touchable key={playlist.id} accessibilityRole="button" highlight disabled={busy} onPress={() => add(() => addToServicePlaylist(service, playlist.id, single), playlist.name)} style={styles.option}>
              <Text style={styles.label} numberOfLines={1}>{playlist.name}</Text>
            </Touchable>)}
          </View>;
        })}
      </ScrollView>}
    </Sheet>
  );
}

export function CreditsSheet({ track, onClose }: { track: Track; onClose: () => void }) {
  const [credits, setCredits] = useState<{ source: string | null; credits: CreditGroup[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void trackCredits(track, abort.signal).then(setCredits).catch(failure => { if (!abort.signal.aborted) setError(reason(failure, "Couldn't load credits.")); });
    return () => abort.abort();
  }, [track]);
  return (
    <Sheet label="Credits" onClose={onClose} grip={<View style={styles.heading}>
      <Text style={styles.title} numberOfLines={2}>Credits</Text>
      <Text style={styles.detail} numberOfLines={1}>{track.name} · {track.artist}</Text>
    </View>}>
      {() => <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {!credits && !error && <ActivityIndicator color={colors.muted} style={styles.loading} />}
        {error && <Text style={styles.error}>{error}</Text>}
        {credits?.credits.length === 0 && <Text style={styles.detail}>No credits are available for this song.</Text>}
        {credits?.credits.map(group => <View key={group.role} style={styles.credit}>
          <Text style={styles.section}>{group.role}</Text>
          <Text style={styles.label}>{group.names.join(", ")}</Text>
        </View>)}
        {credits?.source && <Text style={styles.detail}>From {musicProviderName(credits.source as "tidal")}</Text>}
      </ScrollView>}
    </Sheet>
  );
}

/** A name to type (rename, new playlist) or a yes/no question (delete). */
export function PromptSheet({ title, message, initial, confirmLabel, destructive = false, onSubmit, onClose }: {
  title: string;
  message?: string;
  /** A text field starts with this; leave out for a plain confirmation. */
  initial?: string;
  confirmLabel: string;
  destructive?: boolean;
  onSubmit(value: string): Promise<unknown>;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet label={title} onClose={onClose} grip={<View style={styles.heading}><Text style={styles.title}>{title}</Text></View>}>
      {close => <View style={styles.bodyContent}>
        {message && <Text style={styles.detail}>{message}</Text>}
        {initial !== undefined && <TextInput autoFocus value={value} onChangeText={setValue} keyboardAppearance="dark" selectTextOnFocus style={styles.input} accessibilityLabel={title} />}
        {error && <Text style={styles.error}>{error}</Text>}
        <Touchable accessibilityRole="button" disabled={busy || (initial !== undefined && !value.trim())} haptic={destructive ? "warning" : "firm"}
          onPress={() => { setBusy(true); setError(null); void onSubmit(value).then(close).catch(failure => { setError(reason(failure, "Couldn't save this change.")); setBusy(false); }); }}
          style={[styles.primary, destructive && styles.destructive]}>
          <Text style={[styles.primaryText, destructive && { color: "white" }]}>{busy ? "Saving…" : confirmLabel}</Text>
        </Touchable>
      </View>}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  heading: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 10, gap: 4 },
  title: { color: "white", fontFamily: fonts.serif, fontSize: 28, fontWeight: "500" },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: 8, paddingBottom: 12, gap: 4 },
  section: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 12, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase", paddingTop: 16, paddingBottom: 6 },
  option: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingHorizontal: 8, borderRadius: 10 },
  label: { flex: 1, color: "white", fontFamily: fonts.sans, fontSize: 15 },
  selected: { fontWeight: "600" },
  detail: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, paddingTop: 8 },
  primary: { marginTop: 16, minHeight: 48, borderRadius: 100, backgroundColor: "white", alignItems: "center", justifyContent: "center" },
  primaryText: { color: "black", fontFamily: fonts.sans, fontSize: 15, fontWeight: "600" },
  destructive: { backgroundColor: "#7a2323" },
  job: { paddingVertical: 8, gap: 2 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36 },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: "#5a5a5a", alignItems: "center", justifyContent: "center" },
  boxChecked: { backgroundColor: "white", borderColor: "white" },
  loading: { padding: 16 },
  create: { flexDirection: "row", gap: 8, alignItems: "center", paddingTop: 4 },
  input: { flex: 1, minHeight: 44, borderRadius: 100, borderWidth: 1, borderColor: "#535353", color: "white", fontFamily: fonts.sans, fontSize: 15, paddingHorizontal: 16 },
  createButton: { minHeight: 44, paddingHorizontal: 18, borderRadius: 100, backgroundColor: "white", alignItems: "center", justifyContent: "center" },
  credit: { gap: 2 },
});
