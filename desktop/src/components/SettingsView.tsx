import { useClientConnection } from "../hooks/ClientConnectionContext";
import { useEffect, useState, type RefCallback, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useAudioSettings } from "../hooks/AudioSettingsContext";
import { automaticUpdateChecks, checkForUpdate, installUpdate, setAutomaticUpdateChecks, updatesSupported, useAppUpdate } from "../hooks/useAppUpdate";
import { enabledOutputsFirst, MAX_OUTPUT_LATENCY_MS, MAX_TARGET_LUFS, MIN_TARGET_LUFS, type AudioSettings, type DspPreset, type NormalizationMode, type OutputSettings } from "../utils/audioSettings";
import { ANIMATION_FPS_OPTIONS } from "../utils/frameRate";
import { MAX_LYRICS_OFFSET_MS, type AppPreferences } from "../utils/preferences";
import { setVocalTiming, vocalTimingStatus, type StreamingProvider, type VocalTimingStatus } from "../api/server";
import { musicProviderName } from "../utils/musicProviderName";
import type { SettingsTab } from "./SettingsSidebar";
import { ServiceSettings } from "./ServiceSettings";
import { DspPanel } from "./settings/DspPanel";
import { LocalSettings } from "./settings/LocalSettings";
import { Segmented, SettingRow, Toggle } from "./settings/SettingsControls";
import "./SettingsView.css";
import { ServerSettings } from "./settings/ServerSettings";
import { KeyboardSettings } from "./settings/KeyboardSettings";
import { invokeOn, useEndpoints, type RemoteEndpoint } from "../utils/playbackTarget";
import { coreCommand, coreView, subscribeCore } from "../api/core";
import { serverConnection } from "../api/serverConnection";
import { preferredService, setPreferredService, subscribePreferredService, type PreferredService } from "../utils/servicePreference";

/** Which service's copy is shown when several have a song or album in the same quality. */
/**
 * The server's optional vocal model, which hears where each line's singing ends and lines the
 * lyrics up with the isolated vocals. It downloads once (about 30 MB) and runs on the server.
 */
function VocalTimingSetting() {
  const [status, setStatus] = useState<VocalTimingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const downloading = status?.model.state === "downloading";
  useEffect(() => {
    let cancelled = false;
    const load = () => vocalTimingStatus().then(
      value => { if (!cancelled) { setStatus(value); setError(null); } },
      reason => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); },
    );
    void load();
    // Download progress and the songs waiting are only shown while there is something to show.
    const timer = downloading || status?.pending ? setInterval(load, 2000) : undefined;
    return () => { cancelled = true; clearInterval(timer); };
  }, [downloading, Boolean(status?.pending)]);
  const model = status?.model;
  const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
  const hint = error
    ?? (model?.state === "downloading" ? `Downloading the vocal model, ${megabytes(model.received)} of ${megabytes(model.total)}`
      : model?.state === "failed" ? model.error
        : model?.state === "ready" && status?.pending ? `Analyzing ${status.pending} ${status.pending === 1 ? "song" : "songs"}`
          : undefined);
  return <SettingRow label="Precise lyric timing" hint={hint}
    help={`Your server listens for the vocals in each song, so lyrics end with the singing and line up to within a few hundredths of a second. Downloads a ${status ? megabytes(status.modelBytes) : "30 MB"} model to the server. Songs are analyzed as they play or come up in the queue; slower servers take longer, and each song is analyzed once.`}>
    <Toggle label="Precise lyric timing" checked={Boolean(status?.enabled)} disabled={!status || busy}
      onChange={enabled => {
        setBusy(true);
        setVocalTiming(enabled).then(setStatus, reason => setError(String(reason instanceof Error ? reason.message : reason)))
          .finally(() => setBusy(false));
      }} />
  </SettingRow>;
}

function PreferredServiceSetting() {
  const service = useSyncExternalStore(subscribePreferredService, preferredService);
  const options: { value: PreferredService; label: string }[] = [
    { value: "off", label: "Off" },
    ...(["qobuz", "tidal", "spotify"] as const).map(value => ({ value, label: musicProviderName(value) })),
  ];
  return <div className="settingsGroup">
    <h2>Search</h2>
    <SettingRow label="Preferred service" help="Shown when several services have a song or album in the same quality. Songs and their albums always come from the same service.">
      <Segmented label="Preferred service" value={service} options={options} onChange={setPreferredService} />
    </SettingRow>
  </div>;
}

/** Whether the server's core is playing on this output of this computer, or of `endpointId`. */
function usePlayingOn() {
  const shared = useClientConnection().sharedPlayback;
  const sharedCore = useSyncExternalStore(subscribeCore, coreView);
  const core = shared ? sharedCore : null;
  // A synced group plays on every one of its outputs.
  const outputs = core ? core.outputs ?? (core.output ? [core.output] : []) : [];
  return { core, playingOn: (endpointId: string, deviceId: string) => outputs.some(output => output.endpointId === endpointId && output.deviceId === deviceId) };
}

type SettingsPreferences = Pick<AppPreferences["ui"],
  "showAudioQuality" | "reduceMotion" | "animateSwirl" | "lyricMotion" | "maxAnimationFps"
  | "autoSyncLyrics" | "lyricsOffsetMs" | "servicePlaylistVisibility" | "shortcuts" | "songContextMenu"
>;

type SettingsViewProps = {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  preferences: SettingsPreferences;
  onPreferencesChange: (patch: Partial<SettingsPreferences>) => void;
  onServicePlaylistVisibilityChange: (provider: StreamingProvider, visible: boolean) => void;
  onRescanLocalMusic: () => Promise<number>;
  onServiceConnected: () => void;
  registerScrollElement: RefCallback<HTMLDivElement>;
};

const DESKTOP_ONLY = "Desktop app only";

export function SettingsView({
  tab, onTabChange: setTab, preferences, onPreferencesChange, onServicePlaylistVisibilityChange,
  onRescanLocalMusic, onServiceConnected, registerScrollElement,
}: SettingsViewProps) {
  const {
    showAudioQuality, reduceMotion, animateSwirl, lyricMotion, maxAnimationFps,
    autoSyncLyrics, lyricsOffsetMs, servicePlaylistVisibility, shortcuts, songContextMenu,
  } = preferences;
  const audio = useAudioSettings()!;
  const [presetId, setPresetId] = useState<string | null>(null);
  const setNormalization = (normalization: NormalizationMode) => void audio.update(current => ({ ...current, normalization }));

  return <div className="settingsView" role="region" aria-label="Settings" ref={registerScrollElement}>
    {audio.error && <p className="settingsError" role="alert">{audio.error}</p>}

    <section id="settings-panel-general" role="region" aria-labelledby="settings-tab-general" hidden={tab !== "general"}>
      <header className="settingsPageHeader"><h1 className="settingsTitle">General</h1></header>
      <div className="settingsGroup">
        <h2>Sound</h2>
        <SettingRow label="Volume normalization" hint={audio.native ? undefined : DESKTOP_ONLY}
          help="Evens out loudness between songs with one fixed gain per song or album. Dynamics are untouched: nothing is compressed or limited.">
          {/* Album keeps each album's own balance, so it is where normalization starts. */}
          <Toggle label="Volume normalization" checked={audio.settings.normalization !== "off"} disabled={!audio.native || audio.loading || audio.saving}
            onChange={on => setNormalization(on ? "album" : "off")} />
        </SettingRow>
        {audio.settings.normalization !== "off" && <SettingRow label="Normalize by" help="Album keeps each album's own balance, so quiet tracks stay quiet. Song brings every song to the same loudness.">
          <Segmented label="Normalize by" value={audio.settings.normalization} disabled={audio.saving} onChange={setNormalization}
            options={[{ value: "album", label: "Album" }, { value: "track", label: "Song" }]} />
        </SettingRow>}
        {audio.settings.normalization !== "off" && <SettingRow label="Target loudness" help="The loudness songs are brought to. Higher is louder; quiet songs only rise as far as their peaks allow, so nothing clips.">
          <span className="settingsFieldRow settingsUnitInput">
            <input type="number" aria-label="Target loudness (LUFS)" min={MIN_TARGET_LUFS} max={MAX_TARGET_LUFS} step={0.1} required
              key={audio.settings.normalizationTargetLufs} defaultValue={audio.settings.normalizationTargetLufs} disabled={audio.saving}
              onBlur={async e => {
                const input = e.currentTarget;
                const target = input.valueAsNumber;
                const saved = audio.settings.normalizationTargetLufs;
                if (!input.checkValidity()) { input.reportValidity(); input.value = String(saved); return; }
                if (target !== saved && !await audio.update(current => ({ ...current, normalizationTargetLufs: target }))) input.value = String(saved);
              }} />
            <small>LUFS</small>
          </span>
        </SettingRow>}
      </div>
      <div className="settingsGroup">
        <h2>Player</h2>
        <SettingRow label="Song specs" help="The song's format and bitrate, under the progress bar.">
          <Toggle label="Show song specs" checked={showAudioQuality} onChange={showAudioQuality => onPreferencesChange({ showAudioQuality })} />
        </SettingRow>
        <SettingRow label="Reduce motion" help="Makes transitions instant throughout the app, whatever the system's own animation setting.">
          <Toggle label="Reduce motion" checked={reduceMotion} onChange={reduceMotion => onPreferencesChange({ reduceMotion })} />
        </SettingRow>
        <SettingRow label="Animate swirl" help="Moves the swirl behind the player, whether or not Reduce motion is on.">
          <Toggle label="Animate swirl" checked={animateSwirl} onChange={animateSwirl => onPreferencesChange({ animateSwirl })} />
        </SettingRow>
        <SettingRow label="Lyric motion" help="Default follows Reduce motion. Full animates lyrics even with it on; Reduced keeps them still.">
          <Segmented label="Lyric motion" value={lyricMotion} onChange={lyricMotion => onPreferencesChange({ lyricMotion })}
            options={[{ value: "system", label: "Default" }, { value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }]} />
        </SettingRow>
        <SettingRow label="Animation frame rate" help="Caps how often lyrics and the swirl redraw. A lower cap saves power on high refresh rate displays.">
          <Segmented label="Animation frame rate" value={String(maxAnimationFps)} onChange={fps => onPreferencesChange({ maxAnimationFps: Number(fps) })}
            options={ANIMATION_FPS_OPTIONS.map(fps => ({ value: String(fps), label: fps ? `${fps}` : "Unlimited" }))} />
        </SettingRow>
        <SettingRow label="Auto-sync lyrics" hint={audio.native ? undefined : DESKTOP_ONLY} help="Lines lyrics up with the vocals of the song playing.">
          <Toggle label="Auto-sync lyrics" checked={autoSyncLyrics} disabled={!audio.native} onChange={autoSyncLyrics => onPreferencesChange({ autoSyncLyrics })} />
        </SettingRow>
        <VocalTimingSetting />
        <SettingRow label="Lyrics offset" help="For a delay in your speakers or headphones, like Bluetooth. A positive offset shows lyrics earlier, on every song.">
          <span className="settingsFieldRow settingsUnitInput">
            <input type="number" aria-label="Lyrics offset (milliseconds)" min={-MAX_LYRICS_OFFSET_MS} max={MAX_LYRICS_OFFSET_MS} step={10} required
              key={lyricsOffsetMs} defaultValue={lyricsOffsetMs}
              onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
              onBlur={e => {
                const input = e.currentTarget;
                if (!input.checkValidity()) { input.reportValidity(); input.value = String(lyricsOffsetMs); return; }
                if (input.valueAsNumber !== lyricsOffsetMs) onPreferencesChange({ lyricsOffsetMs: input.valueAsNumber });
              }} />
            <small>ms</small>
          </span>
        </SettingRow>
      </div>
      <div className="settingsGroup">
        <h2>Song controls</h2>
        <SettingRow label="Combined song menu" help="Right-click a song to open its menu instantly. Double-click to play it. A single left-click does nothing.">
          <Toggle label="Combined song menu" checked={songContextMenu} onChange={songContextMenu => onPreferencesChange({ songContextMenu })} />
        </SettingRow>
      </div>
      <PreferredServiceSetting />
      <div className="settingsGroup">
        <h2>Sidebar</h2>
        {(["spotify", "qobuz", "tidal"] as const).map(provider => <SettingRow key={provider} label={`${musicProviderName(provider)} playlists`}>
          <Toggle label={`Show ${musicProviderName(provider)} playlists`} checked={servicePlaylistVisibility[provider]}
            onChange={visible => onServicePlaylistVisibilityChange(provider, visible)} />
        </SettingRow>)}
      </div>
      <UpdateSettings />
    </section>

    <section id="settings-panel-outputs" role="region" aria-labelledby="settings-tab-outputs" hidden={tab !== "outputs"}>
      <header className="settingsPageHeader">
        <h1 className="settingsTitle">Outputs</h1>
        <button type="button" className="settingsPill" onClick={() => void audio.refresh()} disabled={audio.loading || audio.saving}>Refresh</button>
      </header>
      <div className="settingsGroup">
        <h2>{serverConnection?.clientName ?? "This computer"}</h2>
        {!audio.native && <p className="settingsMuted">Choosing devices needs the desktop app.</p>}
        {audio.loading ? <p className="settingsMuted" role="status">Loading outputs…</p> : <div className="settingsOutputs">
          {enabledOutputsFirst(audio.settings.outputs).filter(output => output.id === "" || audio.devices.some(device => device.id === output.id)).map(output => <LocalOutputCard key={output.id} output={output}
            onEditPreset={id => { setPresetId(id); setTab("dsp"); }} />)}
        </div>}
      </div>
      <RemoteOutputs active={tab === "outputs"} />
    </section>

    <section id="settings-panel-dsp" role="region" aria-labelledby="settings-tab-dsp" hidden={tab !== "dsp"}>
      <DspPanel active={tab === "dsp"} presetId={presetId} onPresetChange={setPresetId} />
    </section>

    <section id="settings-panel-services" role="region" aria-labelledby="settings-tab-services" hidden={tab !== "services"}>
      <ServiceSettings active={tab === "services"} onServiceConnected={onServiceConnected} />
    </section>

    <section id="settings-panel-server" role="region" aria-labelledby="settings-tab-server" hidden={tab !== "server"}>
      <ServerSettings active={tab === "server"} />
    </section>

    <section id="settings-panel-local" role="region" aria-labelledby="settings-tab-local" hidden={tab !== "local"}>
      <LocalSettings onRescanLocalMusic={onRescanLocalMusic} />
    </section>

    <section id="settings-panel-keyboard" role="region" aria-labelledby="settings-tab-keyboard" hidden={tab !== "keyboard"}>
      <KeyboardSettings overrides={shortcuts ?? {}} onChange={shortcuts => onPreferencesChange({ shortcuts })} />
    </section>
  </div>;
}

/**
 * One output's settings, the same for an output on this computer and one on another (`on`):
 * its name, whether it shows in the player, DSP, mode, resync delay and sync latency.
 */
function OutputCard({ output, presets, on, playing, busy = false, canPlay, onPlayHere, update, onEditPreset }: {
  output: OutputSettings;
  presets: DspPreset[];
  /** The computer the output is on, when it isn't this one. */
  on?: string;
  playing: boolean;
  busy?: boolean;
  canPlay: boolean;
  onPlayHere: () => void;
  /** Resolves to false when the change wasn't made. */
  update: (change: Partial<OutputSettings>) => Promise<unknown>;
  onEditPreset?: (presetId: string) => void;
}) {
  const where = on ? ` on ${on}` : "";
  return <article className="settingsOutput" data-selected={playing || undefined}>
    <div className="settingsOutputHeader">
      <input className="settingsOutputName" aria-label={`Name for ${output.name}${where}`} key={output.name} defaultValue={output.name} maxLength={200}
        disabled={busy} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
        onBlur={e => { const name = e.currentTarget.value.trim(); if (name && name !== output.name) void update({ name }); else e.currentTarget.value = output.name; }} />
      {playing && <span className="settingsChip settingsChipActive">Playing</span>}
      {output.id === "" && <span className="settingsChip">Follows system</span>}
      <span className="settingsOutputSpacer" />
      {!playing && <button type="button" className="settingsPill" disabled={!canPlay || busy || !output.enabled} onClick={onPlayHere}>Play here</button>}
      <label className="settingsShowInPlayer">In player
        <Toggle label={`Show ${output.name}${where} in player`} checked={output.enabled} disabled={busy} onChange={enabled => void update({ enabled })} />
      </label>
    </div>
    <SettingRow label="DSP preset" help={on ? `Presets are kept on each computer; these are ${on}'s.` : undefined}>
      {output.presetId && onEditPreset && <button type="button" className="settingsLink" onClick={() => onEditPreset(output.presetId!)}>Edit</button>}
      <select aria-label={`DSP preset for ${output.name}${where}`} value={output.presetId ?? ""} disabled={busy}
        onChange={e => void update({ presetId: e.currentTarget.value || null })}>
        <option value="">None</option>
        {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}{preset.enabled ? "" : " (bypassed)"}</option>)}
      </select>
    </SettingRow>
    <SettingRow label="Mode" help="Shared plays alongside other apps' sounds. Exclusive takes the device for Ambra alone, and is bit-perfect when nothing changes the samples.">
      <Segmented label={`Output mode for ${output.name}${where}`} value={output.exclusiveMode ? "exclusive" : "shared"} disabled={busy}
        onChange={mode => void update({ exclusiveMode: mode === "exclusive" })}
        options={[{ value: "shared", label: "Shared" }, { value: "exclusive", label: "Exclusive" }]} />
    </SettingRow>
    <SettingRow label="Resync delay" help="Silence played before a new stream starts, for receivers that need time to lock on to the signal, as when the format changes.">
      <MillisecondsInput label={`Resync delay for ${output.name}${where}`} value={output.resyncDelayMs} max={10000} disabled={busy}
        onChange={resyncDelayMs => update({ resyncDelayMs })} />
    </SettingRow>
    <SettingRow label="Sync latency" help="Delay inside the device that Ambra can't measure, like Bluetooth. When outputs play in sync, this one sends its audio that much earlier.">
      <MillisecondsInput label={`Sync latency for ${output.name}${where}`} value={output.latencyMs ?? 0} max={MAX_OUTPUT_LATENCY_MS} disabled={busy}
        onChange={latencyMs => update({ latencyMs })} />
    </SettingRow>  </article>;
}

/** An output on this computer. */
function LocalOutputCard({ output, onEditPreset }: { output: OutputSettings; onEditPreset: (presetId: string) => void }) {
  const audio = useAudioSettings()!;
  const { core, playingOn } = usePlayingOn();
  const playing = core && serverConnection ? playingOn(serverConnection.clientId, output.id) : audio.settings.selectedOutputId === output.id;
  return <OutputCard output={output} presets={audio.settings.presets} playing={playing} busy={audio.saving} canPlay={audio.native}
    update={change => audio.update(current => ({ ...current, outputs: current.outputs.map(item => item.id === output.id ? { ...item, ...change } : item) }))}
    onPlayHere={() => {
      if (core && serverConnection) {
        void coreCommand("output", { output: { endpointId: serverConnection.clientId, deviceId: output.id, endpointName: serverConnection.clientName, deviceName: output.name } });
      } else void audio.update(current => ({ ...current, selectedOutputId: output.id }));
    }}
    onEditPreset={onEditPreset} />;
}

/** A whole number of milliseconds, saved when the field is left; put back when refused. */
function MillisecondsInput({ label, value, max, disabled, onChange }: { label: string; value: number; max: number; disabled?: boolean; onChange: (milliseconds: number) => Promise<unknown> }) {
  return <span className="settingsFieldRow settingsUnitInput">
    <input type="number" aria-label={label} min={0} max={max} step={1} required
      key={value} defaultValue={value} disabled={disabled}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={async e => {
        const input = e.currentTarget;
        const milliseconds = input.valueAsNumber;
        if (!input.checkValidity()) { input.reportValidity(); input.value = String(value); return; }
        if (milliseconds !== value && await onChange(milliseconds) === false) input.value = String(value);
      }} />
    <small>ms</small>  </span>;
}

function UpdateSettings() {
  const update = useAppUpdate();
  const [version, setVersion] = useState<string | null>(null);
  const [automatic, setAutomatic] = useState(automaticUpdateChecks);
  useEffect(() => {
    if (isTauri()) void getVersion().then(setVersion).catch(() => {});
  }, []);
  const status = !updatesSupported ? "Released desktop app only"
    : update.status === "checking" ? "Checking…"
    : update.status === "current" ? "Up to date"
    : update.status === "available" ? `${update.version} is available`
    : update.status === "installing" ? `Updating${update.progress === null ? "…" : ` · ${Math.round(update.progress * 100)}%`}`
    : update.status === "error" ? update.message
    : null;
  return <div className="settingsGroup">
    <h2>Updates</h2>
    <SettingRow label={version ? `AMBRA ${version}` : "AMBRA"} hint={status}>
      {update.status === "available"
        ? <button type="button" className="settingsPill settingsPillPrimary" onClick={() => void installUpdate()}>Update and restart</button>
        : <button type="button" className="settingsPill" disabled={!updatesSupported || update.status === "checking" || update.status === "installing"}
          onClick={() => void checkForUpdate()}>Check for updates</button>}
    </SettingRow>
    <SettingRow label="Check automatically" help="Ambra only looks for updates; it never installs one without asking.">
      <Toggle label="Check for updates automatically" checked={automatic} disabled={!updatesSupported}
        onChange={next => { setAutomatic(next); setAutomaticUpdateChecks(next); }} />
    </SettingRow>
  </div>;
}

/** Outputs on the other devices using this server, set up from here as on that device. */
function RemoteOutputs({ active }: { active: boolean }) {
  const { connected, sharedPlayback } = useClientConnection();
  const endpoints = useEndpoints(active && connected && sharedPlayback, true);
  if (!endpoints.length) return null;
  return <>{endpoints.map(endpoint => <RemoteEndpointOutputs key={endpoint.id} endpoint={endpoint} />)}</>;
}

function RemoteEndpointOutputs({ endpoint }: { endpoint: RemoteEndpoint }) {
  const [presets, setPresets] = useState<AudioSettings["presets"]>([]);
  const { playingOn } = usePlayingOn();
  const [outputs, setOutputs] = useState<OutputSettings[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = { endpointId: endpoint.id, endpointName: endpoint.name };
  const connected = new Set(["", ...(endpoint.availableDevices ?? endpoint.devices).map(device => device.id)]);
  const load = async () => {
    try { const settings = await invokeOn<AudioSettings>(on, "native_audio_settings"); setOutputs(settings.outputs); setPresets(settings.presets); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  useEffect(() => {
    let disposed = false;
    void invokeOn<AudioSettings>(on, "native_audio_settings").then(settings => {
      if (!disposed) { setOutputs(settings.outputs); setPresets(settings.presets); setError(null); }
    }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [endpoint]);
  // Made on that computer, which keeps its own outputs' settings; false when it refused.
  const changeOutput = async (output: OutputSettings, settings: Partial<OutputSettings>) => {
    setOutputs(current => current?.map(item => item.id === output.id ? { ...item, ...settings } : item) ?? null);
    let made = true;
    try { await invokeOn(on, "set_output_settings", { outputId: output.id, change: settings }); setError(null); }
    catch (reason) { setError(String(reason)); made = false; }
    void load();
    return made;
  };
  return <div className="settingsGroup">
    <h2>{endpoint.name}</h2>
    {error && <p className="settingsError" role="alert">{error}</p>}
    {outputs === null && !error && <p className="settingsMuted" role="status">Loading outputs…</p>}
    {outputs !== null && <div className="settingsOutputs">
      {enabledOutputsFirst(outputs).filter(output => connected.has(output.id)).map(output => <OutputCard key={output.id}
        output={output} presets={presets} on={endpoint.name} playing={playingOn(endpoint.id, output.id)} canPlay
        update={change => changeOutput(output, change)}
        onPlayHere={() => {
          setError(null);
          void coreCommand("output", { output: { endpointId: endpoint.id, endpointName: endpoint.name, deviceId: output.id, deviceName: output.name } })
            .catch(reason => setError(String(reason)));
        }} />)}
    </div>}  </div>;
}
