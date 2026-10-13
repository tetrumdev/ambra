import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type RefCallback } from "react";
import { useAudioSettings } from "../hooks/AudioSettingsContext";
import { newPreset, parseAutoEq, validatePreset, type DspPreset, type DspStatus, type EqBand, type ImpulseFile } from "../utils/audioSettings";
import type { SettingsTab } from "./SettingsSidebar";
import "./SettingsView.css";

type Props = { tab: SettingsTab; onTabChange: (tab: SettingsTab) => void; showAudioQuality: boolean; onShowAudioQuality: (show: boolean) => void; animateSwirl: boolean; onAnimateSwirl: (animate: boolean) => void; registerScrollElement: RefCallback<HTMLDivElement> };

export function SettingsView({ tab, onTabChange: setTab, showAudioQuality, onShowAudioQuality, animateSwirl, onAnimateSwirl, registerScrollElement }: Props) {
  const audio = useAudioSettings()!;
  const [presetId, setPresetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DspPreset | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [status, setStatus] = useState<DspStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const eqFile = useRef<HTMLInputElement>(null);
  const impulseFile = useRef<HTMLInputElement>(null);
  const selectedPreset = audio.settings.presets.find(preset => preset.id === presetId);
  useEffect(() => {
    if (!dirty) setDraft(selectedPreset ? structuredClone(selectedPreset) : null);
  }, [selectedPreset, dirty]);
  useEffect(() => {
    if (tab !== "dsp" || !audio.native) return;
    let disposed = false;
    const read = () => { void invoke<DspStatus>("native_dsp_status").then(value => { if (!disposed) setStatus(value); }).catch(() => {}); };
    read(); const timer = setInterval(read, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [tab, audio.native]);
  const edit = (change: Partial<DspPreset>) => { if (draft) { setDraft({ ...draft, ...change }); setDirty(true); setEditorError(null); } };
  const editBand = (index: number, change: Partial<EqBand>) => edit({ bands: draft!.bands.map((band, i) => i === index ? { ...band, ...change } : band) });
  const save = async () => {
    if (!draft) return;
    try {
      validatePreset(draft);
      const next = { ...draft, name: draft.name.trim() };
      if (await audio.update(current => ({ ...current, presets: current.presets.map(p => p.id === next.id ? next : p) }))) setDirty(false);
    } catch (error) { setEditorError(String(error)); }
  };
  const choosePreset = (id: string | null) => {
    if (dirty) { setEditorError("Save or discard your changes before selecting another preset."); return; }
    setPresetId(id); setEditorError(null);
  };
  const create = async (copy = false) => {
    if (dirty) { setEditorError("Save or discard your changes first."); return; }
    const preset = copy && draft ? { ...structuredClone(draft), id: crypto.randomUUID(), name: `${draft.name} copy`.slice(0, 120) } : newPreset();
    if (await audio.update(current => ({ ...current, presets: [...current.presets, preset] }))) setPresetId(preset.id);
  };
  const remove = async () => {
    if (!draft) return;
    const id = draft.id;
    if (await audio.update(current => ({ ...current, presets: current.presets.filter(p => p.id !== id),
      outputs: current.outputs.map(output => output.presetId === id ? { ...output, presetId: null } : output) }))) {
      setDirty(false); setPresetId(null); setDraft(null);
    }
  };
  const importEq = async (file: File) => {
    try {
      if (file.size > 256 * 1024) throw new Error("EQ text must be at most 256 KB.");
      edit(parseAutoEq(await file.text()));
    } catch (error) { setEditorError(String(error)); }
  };
  const importImpulse = async (file: File) => {
    setImporting(true);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Impulse WAV must be at most 8 MB.");
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const impulse = await invoke<ImpulseFile>("import_dsp_impulse", { name: file.name, bytes });
      edit({ convolution: [...draft!.convolution.filter(i => i.sampleRate !== impulse.sampleRate), impulse] });
    } catch (error) { setEditorError(String(error)); }
    finally { setImporting(false); }
  };
  const connected = new Set(["", ...audio.devices.map(device => device.id)]);
  const updateOutput = (id: string, change: Partial<(typeof audio.settings.outputs)[number]>) => {
    return audio.update(current => ({ ...current, outputs: current.outputs.map(output => output.id === id ? { ...output, ...change } : output) }));
  };
  return <div className="settingsView" role="region" aria-label="Settings" ref={registerScrollElement}>
    {audio.error && <p className="settingsError" role="alert">{audio.error}</p>}
    {!audio.native && tab !== "general" && <p className="settingsNotice">Native DSP and device selection are available in the desktop app. You can prepare presets here.</p>}
    <section id="settings-panel-outputs" role="region" aria-labelledby="settings-tab-outputs" hidden={tab !== "outputs"}>
      <div className="settingsSectionHeading"><div><h2>Audio outputs</h2><p>Choose which devices appear in the player and give each its own sound.</p></div>
        <button className="settingsButton" onClick={() => void audio.refresh()} disabled={audio.loading || audio.saving}>Refresh devices</button></div>
      {audio.loading ? <p role="status">Loading outputs…</p> : <div className="settingsOutputList">{audio.settings.outputs.map(output => <article className="settingsCard settingsOutputCard" key={output.id}>
        <div className="settingsOutputTitle"><div><strong>{output.name}</strong><span>{output.id === "" ? "Follows your system output" : audio.devices.find(d => d.id === output.id)?.name ?? "Disconnected"}
          {audio.settings.selectedOutputId === output.id ? " · Playing here" : ""}</span></div>
          <label className="settingsInlineToggle"><span>Show in player</span><input type="checkbox" role="switch" className="settingsToggle" aria-label={`Show ${output.name} in player`}
            checked={output.enabled} disabled={audio.saving} onChange={e => updateOutput(output.id, { enabled: e.currentTarget.checked })} /></label></div>
        <div className="settingsOutputFields"><label>Display name<input aria-label={`Name for ${output.name}`} key={output.name} defaultValue={output.name} maxLength={200}
          disabled={audio.saving} onBlur={e => { const name = e.currentTarget.value.trim(); if (name && name !== output.name) updateOutput(output.id, { name }); }} /></label>
          <label>DSP preset<select aria-label={`DSP preset for ${output.name}`} value={output.presetId ?? ""} disabled={audio.saving}
            onChange={e => updateOutput(output.id, { presetId: e.currentTarget.value || null })}>
            <option value="">No DSP</option>{audio.settings.presets.map(p => <option key={p.id} value={p.id}>{p.name}{p.enabled ? "" : " (bypassed)"}</option>)}</select></label>
          <label>Output mode<select aria-label={`Output mode for ${output.name}`} value={output.exclusiveMode ? "exclusive" : "shared"} disabled={audio.saving}
            onChange={e => updateOutput(output.id, { exclusiveMode: e.currentTarget.value === "exclusive" })}><option value="shared">System / shared</option><option value="exclusive">Exclusive</option></select></label>
          <label>Resync delay (ms)<input type="number" aria-label={`Resync delay for ${output.name}`} min={0} max={10000} step={1} required
            key={`${output.id}:${output.resyncDelayMs}`} defaultValue={output.resyncDelayMs} disabled={audio.saving}
            onBlur={async e => {
              const input = e.currentTarget;
              const delay = input.valueAsNumber;
              if (!input.checkValidity()) { input.reportValidity(); input.value = String(output.resyncDelayMs); return; }
              if (delay !== output.resyncDelayMs && !await updateOutput(output.id, { resyncDelayMs: delay })) input.value = String(output.resyncDelayMs);
            }} /><span className="settingsFieldHelp">Silence before a new stream or format change. Same-format tracks stay gapless. 0 disables; up to 10,000 ms.</span></label></div>
        <div className="settingsOutputActions"><button className="settingsButton" disabled={!audio.native || audio.saving || !output.enabled || !connected.has(output.id) || audio.settings.selectedOutputId === output.id}
          onClick={() => void audio.update(current => ({ ...current, selectedOutputId: output.id }))}>Use this output</button>
          {output.presetId && <button className="settingsTextButton" onClick={() => { choosePreset(output.presetId); setTab("dsp"); }}>Edit preset</button>}</div>
      </article>)}</div>}
    </section>
    <section id="settings-panel-dsp" role="region" aria-labelledby="settings-tab-dsp" hidden={tab !== "dsp"}>
      <div className="settingsSectionHeading"><div><h2>DSP presets</h2><p>Reusable sound profiles, assigned to outputs in the Outputs tab.</p></div><button className="settingsButton" disabled={audio.loading || audio.saving} onClick={() => void create()}>New preset</button></div>
      <div className="settingsDspLayout"><aside className="settingsPresetList" aria-label="DSP presets">{audio.settings.presets.map(preset => <button key={preset.id} className="settingsPreset" aria-pressed={presetId === preset.id}
        onClick={() => choosePreset(preset.id)}><strong>{preset.name}</strong><span>{preset.enabled ? `${preset.bands.filter(b => b.enabled).length} EQ bands${preset.convolution.length ? " · Convolution" : ""}` : "Bypassed"}</span></button>)}
        {!audio.settings.presets.length && <p>No presets yet.</p>}</aside>
        <div className="settingsDspEditor">{draft ? <>
          <div className="settingsEditorHeading"><label>Preset name<input aria-label="Preset name" maxLength={120} value={draft.name} onChange={e => edit({ name: e.currentTarget.value })} /></label>
            <label className="settingsInlineToggle"><span>DSP enabled</span><input type="checkbox" role="switch" className="settingsToggle" aria-label="DSP enabled" checked={draft.enabled} onChange={e => edit({ enabled: e.currentTarget.checked })} /></label></div>
          <div className="settingsSignalPath" aria-label="DSP signal path"><span>Headroom</span><span>EQ</span><span>Convolution</span><span>Output gain</span><span>Device</span></div>
          <div className="settingsGainFields"><label>Headroom (dB)<input type="number" aria-label="Headroom (dB)" min={0} max={30} step={0.5} value={Number.isFinite(draft.headroomDb) ? draft.headroomDb : ""} onChange={e => edit({ headroomDb: e.currentTarget.valueAsNumber })} /></label>
            <label>Output gain (dB)<input type="number" aria-label="Output gain (dB)" min={-60} max={12} step={0.5} value={Number.isFinite(draft.outputGainDb) ? draft.outputGainDb : ""} onChange={e => edit({ outputGainDb: e.currentTarget.valueAsNumber })} /></label></div>
          <div className="settingsSectionHeading"><h3>Parametric EQ</h3><div className="settingsActions"><button className="settingsButton" onClick={() => eqFile.current?.click()}>Import headphone EQ</button>
            <button className="settingsButton" disabled={draft.bands.length >= 32} onClick={() => edit({ bands: [...draft.bands, { enabled: true, kind: "peak", frequency: 1000, gainDb: 0, q: 1 }] })}>Add band</button></div></div>
          <input ref={eqFile} type="file" accept=".txt,text/plain" hidden aria-label="Import headphone EQ file" onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void importEq(file); e.currentTarget.value = ""; }} />
          <div className="settingsEqTable"><table><thead><tr><th>On</th><th>Filter</th><th>Hz</th><th>dB</th><th>Q</th><th><span className="settingsSrOnly">Remove</span></th></tr></thead>
            <tbody>{draft.bands.map((band, index) => <tr key={index}>
              <td><input type="checkbox" aria-label={`Enable band ${index + 1}`} checked={band.enabled} onChange={e => editBand(index, { enabled: e.currentTarget.checked })} /></td>
              <td><select aria-label={`Filter type band ${index + 1}`} value={band.kind} onChange={e => editBand(index, { kind: e.currentTarget.value as EqBand["kind"] })}><option value="peak">Peak</option><option value="lowShelf">Low shelf</option><option value="highShelf">High shelf</option></select></td>
              <td><input type="number" aria-label={`Frequency band ${index + 1}`} min={10} max={96000} value={Number.isFinite(band.frequency) ? band.frequency : ""} onChange={e => editBand(index, { frequency: e.currentTarget.valueAsNumber })} /></td>
              <td><input type="number" aria-label={`Gain band ${index + 1}`} min={-24} max={24} step={0.1} value={Number.isFinite(band.gainDb) ? band.gainDb : ""} onChange={e => editBand(index, { gainDb: e.currentTarget.valueAsNumber })} /></td>
              <td><input type="number" aria-label={`Q band ${index + 1}`} min={0.1} max={20} step={0.1} value={Number.isFinite(band.q) ? band.q : ""} onChange={e => editBand(index, { q: e.currentTarget.valueAsNumber })} /></td>
              <td><button className="settingsTextButton" aria-label={`Remove band ${index + 1}`} onClick={() => edit({ bands: draft.bands.filter((_, i) => i !== index) })}>×</button></td></tr>)}</tbody></table>
            {!draft.bands.length && <p>No EQ bands. Add one or import AutoEq ParametricEQ.txt.</p>}</div>
          <div className="settingsSectionHeading"><div><h3>Convolution</h3><p>Import a mono or stereo impulse WAV for each playback sample rate.</p></div>
            <button className="settingsButton" disabled={!audio.native || importing} onClick={() => impulseFile.current?.click()}>{importing ? "Importing…" : "Import WAV"}</button></div>
          <input ref={impulseFile} type="file" accept=".wav,audio/wav" hidden aria-label="Import convolution WAV" onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void importImpulse(file); e.currentTarget.value = ""; }} />
          {draft.convolution.map(impulse => <div className="settingsImpulse" key={impulse.id}><span>{impulse.name} <small>{impulse.sampleRate / 1000} kHz · {impulse.channels === 1 ? "Mono" : "Stereo"} · {impulse.frames.toLocaleString()} taps</small></span>
            <button className="settingsTextButton" onClick={() => edit({ convolution: draft.convolution.filter(i => i.id !== impulse.id) })}>Remove</button></div>)}
          {editorError && <p className="settingsError" role="alert">{editorError}</p>}
          <div className="settingsEditorFooter"><button className="settingsButton settingsPrimaryButton" disabled={!dirty || audio.saving || importing} onClick={() => void save()}>{audio.saving ? "Saving…" : "Save preset"}</button>
            <button className="settingsButton" disabled={!dirty} onClick={() => { setDirty(false); setEditorError(null); }}>Discard changes</button>
            <button className="settingsTextButton" disabled={audio.saving} onClick={() => void create(true)}>Duplicate</button><button className="settingsTextButton" disabled={audio.saving} onClick={() => void remove()}>Delete preset</button></div>
        </> : <div className="settingsEmpty"><h3>Shape your sound</h3><p>Create a preset for headphone EQ, headroom, or convolution. Assign it to one or more outputs.</p></div>}</div>
      </div>
      {status && <div className="settingsDspStatus" role="status"><strong>Current playback</strong><span>{status.presetName ?? "No preset"} · {status.active ? "DSP active" : "DSP bypassed"}{status.sampleRate ? ` · ${status.sampleRate / 1000} kHz` : ""}
        {status.peakDbfs !== null ? ` · Peak ${status.peakDbfs.toFixed(1)} dBFS` : ""} · {status.clippedSamples.toLocaleString()} samples over full scale</span>{status.warnings.map(w => <p key={w}>{w}</p>)}</div>}
      <p className="settingsNotice">Bit-perfect playback requires DSP bypass, 100% volume, and a compatible direct output path.</p>
    </section>
    <section id="settings-panel-general" role="region" aria-labelledby="settings-tab-general" hidden={tab !== "general"}>
      <div className="settingsSectionHeading"><div><h2>Playback display</h2><p>Choose what appears in your player.</p></div></div>
      <label className="settingsToggleRow"><span><span className="settingsToggleLabel">Show song specs</span><span className="settingsToggleDescription" id="songSpecsDescription">Show audio quality, format, and bitrate in the playback bar.</span></span>
        <input type="checkbox" role="switch" className="settingsToggle" aria-label="Show song specs" aria-describedby="songSpecsDescription" checked={showAudioQuality} onChange={e => onShowAudioQuality(e.currentTarget.checked)} /></label>
      <label className="settingsToggleRow"><span><span className="settingsToggleLabel">Animate swirl</span><span className="settingsToggleDescription" id="swirlMotionDescription">Keep the bigscreen background moving, independently of system UI animations.</span></span>
        <input type="checkbox" role="switch" className="settingsToggle" aria-label="Animate swirl" aria-describedby="swirlMotionDescription" checked={animateSwirl} onChange={e => onAnimateSwirl(e.currentTarget.checked)} /></label>
    </section>
  </div>;
}
