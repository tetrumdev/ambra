import { useEffect, useState, type RefCallback, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useAudioSettings } from "../hooks/AudioSettingsContext";
import { automaticUpdateChecks, checkForUpdate, installUpdate, setAutomaticUpdateChecks, updatesSupported, useAppUpdate } from "../hooks/useAppUpdate";
import { MAX_TARGET_LUFS, MIN_TARGET_LUFS, type AudioSettings, type NormalizationMode, type OutputSettings } from "../utils/audioSettings";
import { MAX_LYRICS_OFFSET_MS, type LyricMotion } from "../utils/preferences";
import type { StreamingProvider } from "../api/server";
import { musicProviderName } from "../utils/musicProviderName";
import type { SettingsTab } from "./SettingsSidebar";
import { ServiceSettings } from "./ServiceSettings";
import { DspPanel } from "./settings/DspPanel";
import { LocalSettings } from "./settings/LocalSettings";
import { Segmented, SettingRow, Toggle } from "./settings/SettingsControls";
import "./SettingsView.css";
import { ServerSettings } from "./settings/ServerSettings";
import { invokeOn, useEndpoints, type RemoteEndpoint } from "../utils/playbackTarget";
import { coreCommand, coreView, subscribeCore } from "../api/core";
import { serverConnection } from "../api/serverConnection";

/** Whether the server's core is playing on this output of this computer, or of `endpointId`. */
function usePlayingOn() {
  const core = useSyncExternalStore(subscribeCore, coreView);
  return { core, playingOn: (endpointId: string, deviceId: string) => core?.output?.endpointId === endpointId && core.output.deviceId === deviceId };
}

type Props = { onRescanLocalMusic: () => Promise<number>; onServiceConnected: () => void; tab: SettingsTab; onTabChange: (tab: SettingsTab) => void; showAudioQuality: boolean; onShowAudioQuality: (show: boolean) => void; reduceMotion: boolean; onReduceMotion: (reduce: boolean) => void; animateSwirl: boolean; onAnimateSwirl: (animate: boolean) => void; lyricMotion: LyricMotion; onLyricMotionChange: (motion: LyricMotion) => void; autoSyncLyrics: boolean; onAutoSyncLyrics: (enabled: boolean) => void; lyricsOffsetMs: number; onLyricsOffsetChange: (offsetMs: number) => void; servicePlaylistVisibility: Record<StreamingProvider, boolean>; onServicePlaylistVisibilityChange: (provider: StreamingProvider, visible: boolean) => void; registerScrollElement: RefCallback<HTMLDivElement> };

const DESKTOP_ONLY = "Desktop app only";

export function SettingsView({ onRescanLocalMusic, onServiceConnected, tab, onTabChange: setTab, showAudioQuality, onShowAudioQuality, reduceMotion, onReduceMotion, animateSwirl, onAnimateSwirl, lyricMotion, onLyricMotionChange, autoSyncLyrics, onAutoSyncLyrics, lyricsOffsetMs, onLyricsOffsetChange, servicePlaylistVisibility, onServicePlaylistVisibilityChange, registerScrollElement }: Props) {
  const audio = useAudioSettings()!;
  const [presetId, setPresetId] = useState<string | null>(null);
  const setNormalization = (normalization: NormalizationMode) => void audio.update(current => ({ ...current, normalization }));

  return <div className="settingsView" role="region" aria-label="Settings" ref={registerScrollElement}>
    {audio.error && <p className="settingsError" role="alert">{audio.error}</p>}

    <section id="settings-panel-general" role="region" aria-labelledby="settings-tab-general" hidden={tab !== "general"}>
      <header className="settingsPageHeader"><h1 className="settingsTitle">General</h1></header>
      <div className="settingsGroup">
        <h2>Sound</h2>
        <SettingRow label="Volume normalization" hint={audio.native ? "Even loudness, dynamics untouched" : DESKTOP_ONLY}>
          {/* Album keeps each album's own balance, so it is where normalization starts. */}
          <Toggle label="Volume normalization" checked={audio.settings.normalization !== "off"} disabled={!audio.native || audio.loading || audio.saving}
            onChange={on => setNormalization(on ? "album" : "off")} />
        </SettingRow>
        {audio.settings.normalization !== "off" && <SettingRow label="Normalize by" hint="Album keeps quiet tracks quiet">
          <Segmented label="Normalize by" value={audio.settings.normalization} disabled={audio.saving} onChange={setNormalization}
            options={[{ value: "album", label: "Album" }, { value: "track", label: "Song" }]} />
        </SettingRow>}
        {audio.settings.normalization !== "off" && <SettingRow label="Target loudness" hint="Higher is louder; quiet songs only rise as far as their peaks allow">
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
        <SettingRow label="Song specs" hint="Format and bitrate under the progress bar">
          <Toggle label="Show song specs" checked={showAudioQuality} onChange={onShowAudioQuality} />
        </SettingRow>
        <SettingRow label="Reduce motion" hint="Makes transitions instant throughout the app. Independent from system animations">
          <Toggle label="Reduce motion" checked={reduceMotion} onChange={onReduceMotion} />
        </SettingRow>
        <SettingRow label="Animate swirl" hint="Independent from Reduce motion">
          <Toggle label="Animate swirl" checked={animateSwirl} onChange={onAnimateSwirl} />
        </SettingRow>
        <SettingRow label="Lyric motion" hint="Default follows Reduce motion; Full animates even with it on">
          <Segmented label="Lyric motion" value={lyricMotion} onChange={onLyricMotionChange}
            options={[{ value: "system", label: "Default" }, { value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }]} />
        </SettingRow>
        <SettingRow label="Auto-sync lyrics" hint={audio.native ? "Lines lyrics up with the vocals" : DESKTOP_ONLY}>
          <Toggle label="Auto-sync lyrics" checked={autoSyncLyrics} disabled={!audio.native} onChange={onAutoSyncLyrics} />
        </SettingRow>
        <SettingRow label="Lyrics offset" hint="For a delay in your speakers or headphones, like Bluetooth. Positive shows lyrics earlier on every song">
          <span className="settingsFieldRow settingsUnitInput">
            <input type="number" aria-label="Lyrics offset (milliseconds)" min={-MAX_LYRICS_OFFSET_MS} max={MAX_LYRICS_OFFSET_MS} step={10} required
              key={lyricsOffsetMs} defaultValue={lyricsOffsetMs}
              onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
              onBlur={e => {
                const input = e.currentTarget;
                if (!input.checkValidity()) { input.reportValidity(); input.value = String(lyricsOffsetMs); return; }
                if (input.valueAsNumber !== lyricsOffsetMs) onLyricsOffsetChange(input.valueAsNumber);
              }} />
            <small>ms</small>
          </span>
        </SettingRow>
      </div>
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
      {!audio.native && <p className="settingsMuted">Choosing devices needs the desktop app.</p>}
      {audio.loading ? <p className="settingsMuted" role="status">Loading outputs…</p> : <div className="settingsOutputs">
        {audio.settings.outputs.filter(output => output.id === "" || audio.devices.some(device => device.id === output.id)).map(output => <OutputCard key={output.id} output={output}
          onEditPreset={id => { setPresetId(id); setTab("dsp"); }} />)}
      </div>}
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
  </div>;
}

function OutputCard({ output, onEditPreset }: { output: OutputSettings; onEditPreset: (presetId: string) => void }) {
  const audio = useAudioSettings()!;
  const { core, playingOn } = usePlayingOn();
  const selected = core && serverConnection ? playingOn(serverConnection.clientId, output.id) : audio.settings.selectedOutputId === output.id;
  const update = (change: Partial<OutputSettings>) =>
    audio.update(current => ({ ...current, outputs: current.outputs.map(item => item.id === output.id ? { ...item, ...change } : item) }));
  return <article className="settingsOutput" data-selected={selected || undefined}>
    <div className="settingsOutputHeader">
      <input className="settingsOutputName" aria-label={`Name for ${output.name}`} key={output.name} defaultValue={output.name} maxLength={200}
        disabled={audio.saving} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
        onBlur={e => { const name = e.currentTarget.value.trim(); if (name && name !== output.name) void update({ name }); else e.currentTarget.value = output.name; }} />
      {selected && <span className="settingsChip settingsChipActive">Playing here</span>}
      {output.id === "" && <span className="settingsChip">Follows system</span>}
      <span className="settingsOutputSpacer" />
      {!selected && <button type="button" className="settingsPill" disabled={!audio.native || audio.saving || !output.enabled}
        onClick={() => {
          if (core && serverConnection) {
            void coreCommand("output", { output: { endpointId: serverConnection.clientId, deviceId: output.id, endpointName: serverConnection.clientName, deviceName: output.name } });
          } else void audio.update(current => ({ ...current, selectedOutputId: output.id }));
        }}>Play here</button>}
      <span className="settingsShowInPlayer" aria-hidden="true">In player</span>
      <Toggle label={`Show ${output.name} in player`} checked={output.enabled} disabled={audio.saving} onChange={enabled => void update({ enabled })} />
    </div>
    <div className="settingsOutputFields">
      <label className="settingsField"><span>DSP</span>
        <span className="settingsFieldRow">
          <select aria-label={`DSP preset for ${output.name}`} value={output.presetId ?? ""} disabled={audio.saving}
            onChange={e => void update({ presetId: e.currentTarget.value || null })}>
            <option value="">None</option>
            {audio.settings.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}{preset.enabled ? "" : " (bypassed)"}</option>)}
          </select>
          {output.presetId && <button type="button" className="settingsLink" onClick={() => onEditPreset(output.presetId!)}>Edit</button>}
        </span>
      </label>
      <div className="settingsField"><span>Mode</span>
        <Segmented label={`Output mode for ${output.name}`} value={output.exclusiveMode ? "exclusive" : "shared"} disabled={audio.saving}
          onChange={mode => void update({ exclusiveMode: mode === "exclusive" })}
          options={[{ value: "shared", label: "Shared" }, { value: "exclusive", label: "Exclusive" }]} />
      </div>
      <label className="settingsField"><span>Resync delay</span>
        <span className="settingsFieldRow settingsUnitInput">
          <input type="number" aria-label={`Resync delay for ${output.name}`} min={0} max={10000} step={1} required
            key={`${output.id}:${output.resyncDelayMs}`} defaultValue={output.resyncDelayMs} disabled={audio.saving}
            onBlur={async e => {
              const input = e.currentTarget;
              const delay = input.valueAsNumber;
              if (!input.checkValidity()) { input.reportValidity(); input.value = String(output.resyncDelayMs); return; }
              if (delay !== output.resyncDelayMs && !await update({ resyncDelayMs: delay })) input.value = String(output.resyncDelayMs);
            }} />
          <small>ms</small>
        </span>
        <small className="settingsFieldHint">Silence when the format changes</small>
      </label>
    </div>
  </article>;
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
    <SettingRow label="Check automatically" hint="Never installs without asking">
      <Toggle label="Check for updates automatically" checked={automatic} disabled={!updatesSupported}
        onChange={next => { setAutomatic(next); setAutomaticUpdateChecks(next); }} />
    </SettingRow>
  </div>;
}

/** Outputs on the other devices using this server, set up from here as on that device. */
function RemoteOutputs({ active }: { active: boolean }) {
  const endpoints = useEndpoints(active, true);
  if (!endpoints.length) return null;
  return <>{endpoints.map(endpoint => <RemoteEndpointOutputs key={endpoint.id} endpoint={endpoint} />)}</>;
}

function RemoteEndpointOutputs({ endpoint }: { endpoint: RemoteEndpoint }) {
  const audio = useAudioSettings()!;
  const { playingOn } = usePlayingOn();
  const [outputs, setOutputs] = useState<OutputSettings[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const on = { endpointId: endpoint.id, endpointName: endpoint.name };
  const connected = new Set(["", ...endpoint.devices.map(device => device.id)]);
  const load = async () => {
    try { setOutputs((await invokeOn<AudioSettings>(on, "native_audio_settings")).outputs); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  useEffect(() => { void load(); }, [endpoint.id]);
  const change = async (output: OutputSettings, settings: Partial<OutputSettings>) => {
    setOutputs(current => current?.map(item => item.id === output.id ? { ...item, ...settings } : item) ?? null);
    try { await invokeOn(on, "set_output_settings", { outputId: output.id, change: settings }); }
    catch (reason) { setError(String(reason)); }
    void load();
  };
  return <div className="settingsGroup settingsRemoteOutputs">
    <h2>On {endpoint.name}</h2>
    {error && <p className="settingsError" role="alert">{error}</p>}
    {outputs === null && !error && <p className="settingsMuted" role="status">Loading outputs…</p>}
    {outputs?.filter(output => connected.has(output.id)).map(output => {
      const playing = playingOn(endpoint.id, output.id);
      return <article key={output.id} className="settingsOutput" data-selected={playing || undefined}>
        <div className="settingsOutputHeader">
          <strong className="settingsRemoteOutputName">{output.name}</strong>
          {playing && <span className="settingsChip settingsChipActive">Playing here</span>}
          <span className="settingsOutputSpacer" />
          {!playing && <button type="button" className="settingsPill" disabled={!output.enabled} onClick={() => {
            setError(null);
            void coreCommand("output", { output: { endpointId: endpoint.id, endpointName: endpoint.name, deviceId: output.id, deviceName: output.name } })
              .catch(reason => setError(String(reason)));
          }}>Play here</button>}
          <span className="settingsShowInPlayer" aria-hidden="true">In player</span>
          <Toggle label={`Show ${output.name} on ${endpoint.name} in player`} checked={output.enabled} onChange={enabled => void change(output, { enabled })} />
        </div>
        <SettingRow label="DSP preset" hint="Presets are shared by every device">
          <select aria-label={`DSP preset for ${output.name} on ${endpoint.name}`} value={output.presetId ?? ""}
            onChange={event => void change(output, { presetId: event.currentTarget.value || null })}>
            <option value="">None</option>
            {audio.settings.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Exclusive mode" hint="Bit-perfect, with no other sounds">
          <Toggle label={`Exclusive mode for ${output.name} on ${endpoint.name}`} checked={output.exclusiveMode} onChange={exclusiveMode => void change(output, { exclusiveMode })} />
        </SettingRow>
      </article>;
    })}
  </div>;
}
