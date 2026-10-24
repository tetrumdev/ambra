import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAudioSettings } from "../../hooks/AudioSettingsContext";
import { newPreset, parseAutoEq, validatePreset, type DspPreset, type DspStatus, type EqBand, type ImpulseFile } from "../../utils/audioSettings";
import { clippingRiskDb, maxBoostDb } from "../../utils/eqResponse";
import { EqGraph, formatFrequency } from "./EqGraph";
import { Segmented, Toggle } from "./SettingsControls";

const KIND_NAMES: Record<EqBand["kind"], string> = { peak: "Peak", lowShelf: "Low shelf", highShelf: "High shelf" };
const signedDb = (db: number) => `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;

type Props = { active: boolean; presetId: string | null; onPresetChange: (id: string | null) => void };

export function DspPanel({ active, presetId, onPresetChange }: Props) {
  const audio = useAudioSettings()!;
  const [draft, setDraft] = useState<DspPreset | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DspStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const [band, setBand] = useState<number | null>(null);
  const eqFile = useRef<HTMLInputElement>(null);
  const impulseFile = useRef<HTMLInputElement>(null);
  const saved = audio.settings.presets.find(preset => preset.id === presetId);

  useEffect(() => {
    if (!dirty) setDraft(saved ? structuredClone(saved) : null);
  }, [saved, dirty]);
  useEffect(() => setBand(null), [presetId]);
  useEffect(() => {
    if (!active || !audio.native) return;
    let disposed = false;
    const read = () => { void invoke<DspStatus>("native_dsp_status").then(value => { if (!disposed) setStatus(value); }).catch(() => {}); };
    read();
    const timer = setInterval(read, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, audio.native]);

  const edit = (change: Partial<DspPreset>) => {
    if (!draft) return;
    setDraft({ ...draft, ...change });
    setDirty(true);
    setError(null);
  };
  const editBand = (index: number, change: Partial<EqBand>) => edit({ bands: draft!.bands.map((current, i) => i === index ? { ...current, ...change } : current) });
  const addBand = (next: EqBand) => {
    if (!draft || draft.bands.length >= 32) return;
    edit({ bands: [...draft.bands, next] });
    setBand(draft.bands.length);
  };
  const removeBand = (index: number) => {
    if (!draft) return;
    edit({ bands: draft.bands.filter((_, i) => i !== index) });
    setBand(current => current === null || current === index ? null : current > index ? current - 1 : current);
  };

  const choose = (id: string | null) => {
    if (dirty) { setError("Save or discard your changes first."); return; }
    onPresetChange(id);
    setError(null);
  };
  const save = async () => {
    if (!draft) return;
    try {
      validatePreset(draft);
      const next = { ...draft, name: draft.name.trim() };
      if (await audio.update(current => ({ ...current, presets: current.presets.map(p => p.id === next.id ? next : p) }))) setDirty(false);
    } catch (reason) { setError(String(reason)); }
  };
  const create = async (copy = false) => {
    if (dirty) { setError("Save or discard your changes first."); return; }
    const preset = copy && draft ? { ...structuredClone(draft), id: crypto.randomUUID(), name: `${draft.name} copy`.slice(0, 120) } : newPreset();
    if (await audio.update(current => ({ ...current, presets: [...current.presets, preset] }))) onPresetChange(preset.id);
  };
  const remove = async () => {
    if (!draft) return;
    const id = draft.id;
    if (await audio.update(current => ({
      ...current, presets: current.presets.filter(p => p.id !== id),
      outputs: current.outputs.map(output => output.presetId === id ? { ...output, presetId: null } : output),
    }))) {
      setDirty(false);
      onPresetChange(null);
    }
  };
  const importEq = async (file: File) => {
    try {
      if (file.size > 256 * 1024) throw new Error("EQ text must be at most 256 KB.");
      edit(parseAutoEq(await file.text()));
      setBand(null);
    } catch (reason) { setError(String(reason)); }
  };
  const importImpulse = async (file: File) => {
    setImporting(true);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Impulse WAV must be at most 8 MB.");
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const impulse = await invoke<ImpulseFile>("import_dsp_impulse", { name: file.name, bytes });
      edit({ convolution: [...draft!.convolution.filter(i => i.sampleRate !== impulse.sampleRate), impulse] });
    } catch (reason) { setError(String(reason)); }
    finally { setImporting(false); }
  };

  const boost = useMemo(() => draft ? maxBoostDb(draft.bands) : 0, [draft]);
  const risk = draft ? clippingRiskDb(draft) : 0;
  const usedBy = draft ? audio.settings.outputs.filter(output => output.presetId === draft.id) : [];
  const playing = status && draft && status.presetName === saved?.name ? status : null;
  const selectedBand = band !== null && draft?.bands[band] ? draft.bands[band] : null;

  return <>
    <header className="settingsPageHeader">
      <h1 className="settingsTitle">DSP</h1>
      <button type="button" className="settingsPill settingsPillPrimary" disabled={audio.loading || audio.saving} onClick={() => void create()}>New preset</button>
    </header>
    <div className="dspLayout">
      <nav className="dspPresets" aria-label="DSP presets">
        {audio.settings.presets.map(preset => <button key={preset.id} type="button" className="dspPresetItem" aria-pressed={presetId === preset.id} onClick={() => choose(preset.id)}>
          <strong>{preset.name}</strong>
          <span>{preset.enabled ? [`${preset.bands.filter(b => b.enabled).length} bands`, preset.convolution.length ? "convolution" : null].filter(Boolean).join(" · ") : "Bypassed"}</span>
          {dirty && presetId === preset.id && <em>Unsaved</em>}
        </button>)}
        {!audio.settings.presets.length && <p className="settingsMuted">No presets yet.</p>}
      </nav>

      {draft ? <div className="dspEditor">
        <div className="dspEditorHeader">
          <input className="dspPresetName" aria-label="Preset name" maxLength={120} value={draft.name} onChange={e => edit({ name: e.currentTarget.value })} />
          <Toggle label="DSP enabled" checked={draft.enabled} onChange={enabled => edit({ enabled })} />
          <button type="button" className="settingsLink" disabled={audio.saving} onClick={() => void create(true)}>Duplicate</button>
          <button type="button" className="settingsLink" disabled={audio.saving} onClick={() => void remove()}>Delete</button>
        </div>
        <p className="settingsMuted dspUsedBy">{usedBy.length ? `Used by ${usedBy.map(output => output.name).join(", ")}` : "Not used by an output yet. Pick it in Outputs."}</p>

        <ol className="dspSignalPath" aria-label="Signal path" data-bypassed={!draft.enabled || undefined}>
          <li><span>Source</span><strong>{playing?.sampleRate ? `${playing.sampleRate / 1000} kHz` : "Song"}</strong></li>
          <li data-off={draft.headroomDb === 0 || undefined}><span>Headroom</span><strong>{signedDb(-draft.headroomDb)}</strong></li>
          <li data-off={!draft.bands.some(b => b.enabled && b.gainDb !== 0) || undefined}><span>Parametric EQ</span><strong>{draft.bands.filter(b => b.enabled).length} bands</strong></li>
          <li data-off={!draft.convolution.length || undefined}><span>Convolution</span><strong>{draft.convolution.length ? `${draft.convolution.length} ${draft.convolution.length === 1 ? "filter" : "filters"}` : "Off"}</strong></li>
          <li data-clipping={playing && playing.clippedSamples > 0 || undefined}><span>Output</span>
            <strong>{playing ? playing.peakDbfs !== null ? `Peak ${playing.peakDbfs.toFixed(1)} dBFS` : "Silent" : "Not playing"}</strong>
            {playing && playing.clippedSamples > 0 && <em>{playing.clippedSamples.toLocaleString()} clipped</em>}</li>
        </ol>
        {playing?.warnings.map(warning => <p key={warning} className="settingsMuted">{warning}</p>)}

        {risk > 0.05 && draft.enabled && <div className="dspWarning" role="status">
          <span>Boosts up to {signedDb(boost)} can clip with {signedDb(-draft.headroomDb)} of headroom.</span>
          <button type="button" className="settingsPill" onClick={() => edit({ headroomDb: Math.min(30, Math.ceil((draft.headroomDb + risk) * 2) / 2) })}>
            Set headroom to {signedDb(-Math.min(30, Math.ceil((draft.headroomDb + risk) * 2) / 2))}
          </button>
        </div>}

        <div className="dspGains">
          <NumberField label="Headroom" unit="dB" ariaLabel="Headroom (dB)" value={draft.headroomDb} min={0} max={30} step={0.1} onChange={headroomDb => edit({ headroomDb })} />
        </div>

        <section className="dspSection" aria-label="Parametric EQ">
          <div className="dspSectionHeader">
            <h2>Parametric EQ</h2>
            <div className="dspSectionActions">
              <button type="button" className="settingsPill" disabled={draft.bands.length >= 32} onClick={() => addBand({ enabled: true, kind: "peak", frequency: 1000, gainDb: 0, q: 1 })}>Add band</button>
              <button type="button" className="settingsPill" onClick={() => eqFile.current?.click()}>Import AutoEq</button>
              {draft.bands.length > 0 && <button type="button" className="settingsLink" onClick={() => { edit({ bands: [] }); setBand(null); }}>Clear</button>}
            </div>
          </div>
          <input ref={eqFile} type="file" accept=".txt,text/plain" hidden aria-label="Import headphone EQ file"
            onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void importEq(file); e.currentTarget.value = ""; }} />
          <EqGraph bands={draft.bands} selected={band} onSelect={setBand} onChange={editBand} onAdd={addBand} onRemove={removeBand} />
          <p className="dspHint">Drag a band to move it · scroll over it for width · double-click to add · right-click to remove</p>
          {draft.bands.length > 0 && <div className="dspBandChips" role="listbox" aria-label="EQ bands">
            {draft.bands.map((item, index) => <button key={index} type="button" role="option" aria-selected={band === index} data-off={!item.enabled || undefined}
              className="dspBandChip" onClick={() => setBand(band === index ? null : index)}>
              <b>{index + 1}</b>{formatFrequency(item.frequency)}Hz <span>{item.gainDb > 0 ? "+" : ""}{item.gainDb}</span>
            </button>)}
          </div>}
          {selectedBand && band !== null && <div className="dspBandInspector" aria-label={`Band ${band + 1}`} role="group">
            <div className="dspBandInspectorRow">
              <span className="dspBandNumber">{band + 1}</span>
              <Segmented label={`Filter type band ${band + 1}`} value={selectedBand.kind} onChange={kind => editBand(band, { kind })}
                options={(Object.keys(KIND_NAMES) as EqBand["kind"][]).map(kind => ({ value: kind, label: KIND_NAMES[kind] }))} />
              <Toggle label={`Enable band ${band + 1}`} checked={selectedBand.enabled} onChange={enabled => editBand(band, { enabled })} />
              <button type="button" className="settingsLink" aria-label={`Remove band ${band + 1}`} onClick={() => removeBand(band)}>Remove</button>
            </div>
            <div className="dspBandInspectorRow">
              <NumberField label="Frequency" unit="Hz" ariaLabel={`Frequency band ${band + 1}`} value={selectedBand.frequency} min={10} max={96000} step={1} onChange={frequency => editBand(band, { frequency })} />
              <NumberField label="Gain" unit="dB" ariaLabel={`Gain band ${band + 1}`} value={selectedBand.gainDb} min={-24} max={24} step={0.1} onChange={gainDb => editBand(band, { gainDb })} />
              <NumberField label="Q" ariaLabel={`Q band ${band + 1}`} value={selectedBand.q} min={0.1} max={20} step={0.05} onChange={q => editBand(band, { q })} />
            </div>
          </div>}
        </section>

        <section className="dspSection" aria-label="Convolution">
          <div className="dspSectionHeader">
            <h2>Convolution</h2>
            <button type="button" className="settingsPill" disabled={!audio.native || importing} onClick={() => impulseFile.current?.click()}>{importing ? "Importing…" : "Import WAV"}</button>
          </div>
          <input ref={impulseFile} type="file" accept=".wav,audio/wav" hidden aria-label="Import convolution WAV"
            onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void importImpulse(file); e.currentTarget.value = ""; }} />
          {draft.convolution.length ? <ul className="dspImpulses">{draft.convolution.map(impulse => <li key={impulse.id}>
            <span className="dspImpulseRate">{impulse.sampleRate / 1000} kHz</span>
            <span className="dspImpulseName">{impulse.name}<small>{impulse.channels === 1 ? "Mono" : "Stereo"} · {impulse.frames.toLocaleString()} taps · {(impulse.frames / impulse.sampleRate * 1000).toFixed(0)} ms</small></span>
            <button type="button" className="settingsLink" onClick={() => edit({ convolution: draft.convolution.filter(i => i.id !== impulse.id) })}>Remove</button>
          </li>)}</ul> : <p className="settingsMuted">One impulse per sample rate, mono or stereo.</p>}
        </section>
      </div> : <div className="dspEmpty">
        <h2>Shape your sound</h2>
        <p className="settingsMuted">Headphone EQ, room correction and headroom, saved as presets you give to outputs.</p>
        <button type="button" className="settingsPill settingsPillPrimary" disabled={audio.loading || audio.saving} onClick={() => void create()}>New preset</button>
      </div>}
    </div>
    {error && <p className="settingsError" role="alert">{error}</p>}
    <p className="settingsMuted dspFootnote">Bit-perfect in exclusive mode with DSP off and volume at 100%. Otherwise processed in 64-bit and dithered to the device.</p>
    {dirty && <div className="settingsSaveBar" role="region" aria-label="Unsaved changes">
      <span>Unsaved changes</span>
      <button type="button" className="settingsLink" onClick={() => { setDirty(false); setError(null); }}>Discard changes</button>
      <button type="button" className="settingsPill settingsPillPrimary" disabled={audio.saving || importing} onClick={() => void save()}>{audio.saving ? "Saving…" : "Save preset"}</button>
    </div>}
  </>;
}

function NumberField({ label, unit, ariaLabel, value, min, max, step, onChange }: {
  label: string; unit?: string; ariaLabel: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void;
}) {
  return <label className="dspNumber">
    <span>{label}</span>
    <span className="dspNumberInput">
      <input type="number" aria-label={ariaLabel} min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""}
        onChange={e => onChange(e.currentTarget.valueAsNumber)} />
      {unit && <small>{unit}</small>}
    </span>
  </label>;
}
