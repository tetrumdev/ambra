import { useClientConnection } from "../hooks/ClientConnectionContext";
import { isTauri } from "@tauri-apps/api/core";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { AudioControlsMenu } from "./AudioControlsMenu";
import { useAudioSettings } from "../hooks/AudioSettingsContext";
import { visibleOutputs, type AudioSettings } from "../utils/audioSettings";
import { acceptsPlaybackShortcut } from "../utils/keyboard";
import { matchesShortcut } from "../utils/shortcuts";
import "./ExtraCtrls.css";
import { invokeOn, useEndpoints } from "../utils/playbackTarget";
import { coreCommand, coreOutputs, coreSession, coreSessions, coreView, setCoreStages, subscribeCore, type CoreOutput, type CoreStage } from "../api/core";
import { serverConnection } from "../api/serverConnection";

/** How far keyboard and wheel input change the volume, in percent. */
const VOLUME_STEP = 5;
/** Where unmuting goes for an output that was already silent when muted. */
const UNMUTE_FALLBACK_VOLUME = 50;
// Each output's level before M muted it, so M restores it.
const levelsBeforeMute = new Map<string, number>();

function clampVolume(volume: number) {
  return Math.min(100, Math.max(0, volume));
}

function outputKey(output: { endpointId: string; deviceId: string }) {
  return `${output.endpointId}:${output.deviceId}`;
}

/** The same outputs, in any order. */
function sameOutputs(left: CoreOutput[], right: CoreOutput[]) {
  const keys = new Set(left.map(outputKey));
  return left.length === right.length && right.every(output => keys.has(outputKey(output)));
}

const volumeLevels = ["muted", "mid", "high"] as const;
function volumeLevel(volume: number) {
  return volume <= 0 ? "muted" : volume < 50 ? "mid" : "high";
}

type ExtraCtrlsProps = {
  onToggleQueue?: () => void;
  queueSidebarOpen?: boolean;
};

export function ExtraCtrls({ onToggleQueue, queueSidebarOpen }: ExtraCtrlsProps) {
  const hasNativeAudio = isTauri();
  const audio = useAudioSettings();
  const isChangingDevice = audio?.saving ?? false;
  const isLoadingDevices = audio?.loading ?? false;
  const selectedDeviceId = audio?.settings.selectedOutputId ?? "";
  const audioDevices = audio
    ? visibleOutputs(audio.settings, audio.devices)
    : [];
  const showAudioModeToggle = hasNativeAudio;
  const [volumePreview, setVolumePreview] = useState<{ outputId: string; volume: number } | null>(null);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  // With a server, its core picks the output from every computer's; the volume lives on the
  // computer that output belongs to.
  const shared = useClientConnection().sharedPlayback;
  const sharedCore = useSyncExternalStore(subscribeCore, coreView);
  const core = shared ? sharedCore : null;
  const coreOutput = core?.output ?? null;
  const target = coreOutput && coreOutput.endpointId !== serverConnection?.clientId ? coreOutput : null;
  const endpoints = useEndpoints(audioMenuOpen && core !== null, true);
  // Stages: the session's named groups of outputs, played on together in step.
  const currentSession = useSyncExternalStore(subscribeCore, coreSession);
  const [stages, setStages] = useState<CoreStage[] | null>(null);
  const [newStage, setNewStage] = useState<{ name: string; outputs: CoreOutput[] } | null>(null);
  const following = core !== null;
  useEffect(() => {
    if (!audioMenuOpen || !following) return;
    let disposed = false;
    setNewStage(null);
    void coreSessions().then(list => {
      // A server from before stages has none to offer.
      if (!disposed) setStages(list.find(session => session.id === currentSession)?.stages ?? null);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [audioMenuOpen, following, currentSession]);
  const isPlayingHere = (deviceId: string) => core ? coreOutput?.endpointId === serverConnection?.clientId && coreOutput?.deviceId === deviceId : selectedDeviceId === deviceId;
  const pickHere = (deviceId: string, deviceName: string) => {
    if (core && serverConnection) chooseOutput({ endpointId: serverConnection.clientId, deviceId, endpointName: serverConnection.clientName, deviceName });
    else void selectAudioDevice(deviceId);
  };
  const [targetError, setTargetError] = useState<string | null>(null);
  // The server switched this computer's output; its settings say which one now.
  const ownDeviceId = coreOutput && !target ? coreOutput.deviceId : null;
  useEffect(() => {
    if (ownDeviceId !== null && ownDeviceId !== audio?.settings.selectedOutputId) void audio?.refresh();
  }, [ownDeviceId]);
  const pendingVolumes = useRef(new Map<string, { outputId: string; volume: number }>());
  const isSendingVolume = useRef(false);
  const volumeButton = useRef<HTMLButtonElement>(null);

  // Every output playing keeps its own volume, set from the slider under it; the volume button
  // shows the leading one's, and keys and the wheel move them all together.
  const groupOutputs = coreOutputs(core);
  const isOnThisComputer = (output: CoreOutput) => output.endpointId === serverConnection?.clientId;
  const [remoteVolumes, setRemoteVolumes] = useState<Record<string, number>>({});
  const remoteMembers = groupOutputs.filter(member => !isOnThisComputer(member));
  const remoteMembersKey = remoteMembers.map(outputKey).join("|");
  useEffect(() => {
    if (remoteMembers.length === 0) return;
    let disposed = false;
    for (const member of remoteMembers) {
      // Each output's own saved level: `native_audio_volume` answers only for the app's own player
      // there, so every other output on that computer would show (and step from) its level.
      void invokeOn<AudioSettings>(member, "native_audio_settings")
        .then(settings => {
          const value = settings.outputs.find(output => output.id === member.deviceId)?.volume ?? 100;
          if (!disposed) setRemoteVolumes(current => ({ ...current, [outputKey(member)]: value }));
        })
        .catch(() => {});
    }
    return () => { disposed = true; };
  }, [remoteMembersKey, audioMenuOpen]);
  const localVolume = (deviceId: string) => volumePreview?.outputId === deviceId
    ? volumePreview.volume
    : audio?.settings.outputs.find(output => output.id === deviceId)?.volume ?? 100;
  const memberVolume = (output: CoreOutput) => isOnThisComputer(output)
    ? localVolume(output.deviceId)
    : remoteVolumes[outputKey(output)] ?? 100;
  // Levels just set, ahead of the render showing them, so wheel steps build on one another.
  const recentLevels = useRef(new Map<string, { volume: number; at: number }>());
  const currentLevel = (output: CoreOutput) => {
    const recent = recentLevels.current.get(outputKey(output));
    return recent && performance.now() - recent.at < 1000 ? recent.volume : memberVolume(output);
  };
  const remoteVolumeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const setMemberVolume = (output: CoreOutput, nextVolume: number) => {
    const key = outputKey(output);
    recentLevels.current.set(key, { volume: nextVolume, at: performance.now() });
    if (isOnThisComputer(output)) {
      setLocalVolume(output.deviceId, nextVolume);
      return;
    }
    setRemoteVolumes(current => ({ ...current, [key]: nextVolume }));
    // A drag sends its latest level, not every step, over the network.
    clearTimeout(remoteVolumeTimers.current.get(key));
    remoteVolumeTimers.current.set(key, setTimeout(() => {
      remoteVolumeTimers.current.delete(key);
      void coreCommand("volume", { volume: nextVolume, output }).catch(error => setTargetError(String(error)));
    }, 80));
  };
  const volume = groupOutputs.length > 0 ? memberVolume(groupOutputs[0]) : localVolume(selectedDeviceId);

  const chooseOutput = (output: CoreOutput) => {
    setTargetError(null);
    void coreCommand("output", { output }).catch(error => setTargetError(String(error)));
  };

  // With a server, choosing an output plays there alone; a stage plays on all of its outputs in
  // step. While a new stage is made, the box beside each output picks it for the stage.
  const sameOutput = (output: CoreOutput) => (member: CoreOutput) => member.endpointId === output.endpointId && member.deviceId === output.deviceId;
  const inGroup = (output: CoreOutput) => groupOutputs.some(sameOutput(output));
  const saveStages = async (next: CoreStage[]) => {
    const list = await setCoreStages(currentSession, next);
    setStages(list.find(session => session.id === currentSession)?.stages ?? next);
  };
  const playStage = (stage: CoreStage) => {
    setTargetError(null);
    void coreCommand("outputs", { outputs: stage.outputs }).catch(error => setTargetError(String(error)));
  };
  const createStage = () => {
    if (!newStage || !stages || !newStage.name.trim() || newStage.outputs.length === 0) return;
    const stage = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), name: newStage.name.trim(), outputs: newStage.outputs };
    setTargetError(null);
    void saveStages([...stages, stage]).then(() => { setNewStage(null); playStage(stage); }).catch(error => setTargetError(String(error)));
  };
  const removeStage = (stage: CoreStage) => {
    if (!stages) return;
    setTargetError(null);
    void saveStages(stages.filter(other => other.id !== stage.id)).catch(error => setTargetError(String(error)));
  };
  const togglePicked = (output: CoreOutput) => setNewStage(current => current && {
    ...current,
    outputs: current.outputs.some(sameOutput(output)) ? current.outputs.filter(member => !sameOutput(output)(member)) : [...current.outputs, output],
  });
  const groupRow = (output: CoreOutput, label: string, { syncs, disabled = false, offline = false }: { syncs: boolean; disabled?: boolean; offline?: boolean }) => {
    const playing = inGroup(output);
    const picked = newStage?.outputs.some(sameOutput(output)) ?? false;
    const level = memberVolume(output);
    return <Fragment key={outputKey(output)}><div className="audioDeviceRow">
      <button
        className="audioDeviceOption"
        type="button"
        aria-current={(!newStage && playing) || undefined}
        aria-label={label}
        disabled={disabled || offline || (newStage !== null && !syncs)}
        onClick={() => newStage ? togglePicked(output) : chooseOutput(output)}
      >
        <span className="audioDeviceCheck" aria-hidden="true" />
        <span className="audioDeviceName" data-tooltip={label}>
          {offline ? `${output.deviceName} (offline)` : output.deviceName}
        </span>
      </button>
      {newStage && <button
        className="audioDeviceToggle"
        type="button"
        role="checkbox"
        aria-checked={picked}
        aria-label={`Add ${label} to the stage`}
        data-tooltip={syncs ? undefined : "Update Ambra there to play in sync"}
        disabled={!syncs}
        onClick={() => togglePicked(output)}
      >
        <span className="audioDeviceBox" aria-hidden="true" />
      </button>}
    </div>
    {playing && !offline && !newStage && <div className="audioDeviceVolume">
      <input
        className="volumeSlider"
        type="range"
        min="0"
        max="100"
        step="1"
        value={level}
        aria-label={`${label} volume`}
        aria-valuetext={`${Math.round(level)}%`}
        onChange={event => setMemberVolume(output, Number(event.target.value))}
        style={{ "--volume": `${level}%` } as CSSProperties}
      />
    </div>}
    </Fragment>;
  };
  const here = core && serverConnection ? serverConnection : null;
  // Outputs playing that the list doesn't show, because their computer is out of reach.
  const offlineMembers = groupOutputs.filter(member => member.endpointId !== here?.clientId && !endpoints.some(endpoint => endpoint.id === member.endpointId));
  // Every computer's outputs in one list, by name: renaming them is how they're told apart and
  // kept in order, not which computer they're on.
  const outputRows = here ? [
    ...audioDevices.map(device => ({
      output: { endpointId: here.clientId, deviceId: device.id, endpointName: here.clientName, deviceName: device.name },
      syncs: true, disabled: isChangingDevice, offline: false,
    })),
    ...endpoints.flatMap(endpoint => endpoint.devices.map(device => ({
      output: { endpointId: endpoint.id, endpointName: endpoint.name, deviceId: device.id, deviceName: device.name },
      syncs: endpoint.syncs, disabled: false, offline: false,
    }))),
    ...offlineMembers.map(output => ({ output, syncs: true, disabled: false, offline: true })),
  ].sort((a, b) => a.output.deviceName.localeCompare(b.output.deviceName, undefined, { sensitivity: "base", numeric: true })
    || a.output.endpointName.localeCompare(b.output.endpointName)) : [];

  const selectAudioDevice = async (deviceId: string) => {
    if (!audio || audio.saving) return;
    setTargetError(null);
    await audio.update((current) => ({
      ...current,
      selectedOutputId: deviceId,
    }));
  };

  const sendPendingVolume = async () => {
    if (!audio || isSendingVolume.current) return;

    isSendingVolume.current = true;
    try {
      while (pendingVolumes.current.size > 0) {
        const next = pendingVolumes.current.values().next().value!;
        pendingVolumes.current.delete(next.outputId);
        await audio.update((current) => ({
          ...current,
          outputs: current.outputs.map((output) =>
            output.id === next.outputId ? { ...output, volume: next.volume } : output,
          ),
        }));
        setVolumePreview((current) => current === next ? null : current);
      }
    } finally {
      isSendingVolume.current = false;
    }
  };

  // Follows each change at once, so wheel events arriving between renders build on one another.
  const latestVolume = useRef(volume);
  latestVolume.current = groupOutputs.length > 0 ? currentLevel(groupOutputs[0]) : volume;
  function setLocalVolume(outputId: string, nextVolume: number) {
    if (!audio || audio.loading) return;
    const next = { outputId, volume: nextVolume };
    setVolumePreview(next);
    pendingVolumes.current.set(next.outputId, next);
    void sendPendingVolume();
  }
  // Moves every output playing by the same step, each from its own level.
  const stepVolume = (step: number) => {
    if (groupOutputs.length === 0) {
      const next = clampVolume(latestVolume.current + step);
      if (next === latestVolume.current) return;
      latestVolume.current = next;
      setLocalVolume(selectedDeviceId, next);
      return;
    }
    for (const output of groupOutputs) {
      const level = currentLevel(output);
      const next = clampVolume(level + step);
      if (next !== level) setMemberVolume(output, next);
    }
  };

  // Up/Down move between devices, as in a native menu.
  const moveDeviceFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ".audioDeviceOption:not(:disabled)",
      ),
    ];
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(current + step + options.length) % options.length]?.focus();
  };

  const closeAudioMenu = () => {
    setAudioMenuOpen(false);
    volumeButton.current?.focus();
  };

  // Mutes every output playing, and gives each its own level back.
  const toggleMute = () => {
    const muting = latestVolume.current > 0;
    if (groupOutputs.length === 0) {
      if (muting) levelsBeforeMute.set(selectedDeviceId, latestVolume.current);
      const next = muting ? 0 : levelsBeforeMute.get(selectedDeviceId) ?? UNMUTE_FALLBACK_VOLUME;
      latestVolume.current = next;
      setLocalVolume(selectedDeviceId, next);
      return;
    }
    for (const output of groupOutputs) {
      const key = outputKey(output);
      if (muting) {
        const level = currentLevel(output);
        if (level > 0) levelsBeforeMute.set(key, level);
        setMemberVolume(output, 0);
      } else {
        setMemberVolume(output, levelsBeforeMute.get(key) ?? UNMUTE_FALLBACK_VOLUME);
      }
    }
  };

  // M mutes and unmutes; Up and Down step the volume, repeating while held.
  const shortcuts = useRef({ toggleMute, stepVolume });
  shortcuts.current = { toggleMute, stepVolume };
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const step = matchesShortcut(event, "volumeUp") ? VOLUME_STEP
        : matchesShortcut(event, "volumeDown") ? -VOLUME_STEP : 0;
      if (step !== 0) {
        if (!acceptsPlaybackShortcut(event, true, true)) return;
        event.preventDefault();
        shortcuts.current.stepVolume(step);
      } else if (matchesShortcut(event, "toggleMute") && acceptsPlaybackShortcut(event, false, true)) {
        event.preventDefault();
        if (event.repeat) return;
        shortcuts.current.toggleMute();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Wheel distances vary between platforms; each vertical event moves one fixed step.
  const volumeControl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const control = volumeControl.current;
    if (!control) return;
    const handleWheel = (event: WheelEvent) => {
      // The output list in the open menu scrolls as usual.
      if (event.target instanceof Element && event.target.closest(".audioDeviceList")) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      shortcuts.current.stepVolume(-Math.sign(event.deltaY) * VOLUME_STEP);
    };
    control.addEventListener("wheel", handleWheel, { passive: false });
    return () => control.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <div id="extraCtrls">
      <div className="volumeControlContainer" ref={volumeControl}>
        {hasNativeAudio && audioMenuOpen && (
          <AudioControlsMenu anchor={volumeButton} onClose={closeAudioMenu}>
            {showAudioModeToggle && (
              <>
                <div
                  className="audioDeviceList"
                  role={here ? "group" : "radiogroup"}
                  aria-label="Audio output device"
                  onKeyDown={moveDeviceFocus}
                >
                  {here && stages && <>
                    <span className="audioDeviceHeading" aria-hidden="true">Stages</span>
                    {stages.map(stage => <div key={`stage:${stage.id}`} className="audioDeviceRow">
                      <button
                        className="audioDeviceOption"
                        type="button"
                        aria-current={sameOutputs(stage.outputs, groupOutputs) || undefined}
                        aria-label={`${stage.name} stage: ${stage.outputs.map(output => output.deviceName).join(", ")}`}
                        disabled={newStage !== null}
                        onClick={() => playStage(stage)}
                      >
                        <span className="audioDeviceCheck" aria-hidden="true" />
                        <span className="audioDeviceName" data-tooltip={stage.outputs.map(output => output.deviceName).join(", ")}>{stage.name}</span>
                      </button>
                      <button
                        className="audioDeviceRemove"
                        type="button"
                        aria-label={`Remove the ${stage.name} stage`}
                        data-tooltip="Remove stage"
                        disabled={newStage !== null}
                        onClick={() => removeStage(stage)}
                      >×</button>
                    </div>)}
                    {newStage ? <form className="audioStageForm" onSubmit={event => { event.preventDefault(); createStage(); }}>
                      <input
                        type="text"
                        aria-label="Stage name"
                        placeholder="Stage name"
                        maxLength={60}
                        autoFocus
                        value={newStage.name}
                        onChange={event => setNewStage({ ...newStage, name: event.target.value })}
                      />
                      <button type="submit" disabled={!newStage.name.trim() || newStage.outputs.length === 0}>Create</button>
                      <button type="button" onClick={() => setNewStage(null)}>Cancel</button>
                    </form> : <button
                      className="audioDeviceOption audioStageNew"
                      type="button"
                      onClick={() => setNewStage({ name: "", outputs: [...groupOutputs] })}
                    >
                      <span className="audioDeviceCheck" aria-hidden="true">+</span>
                      <span className="audioDeviceName">New stage</span>
                    </button>}
                    {newStage && <p className="audioControlsNote">Tick the outputs to play on together.</p>}
                  </>}
                  <span className="audioDeviceHeading" aria-hidden="true">
                    {here ? "Outputs" : "Output"}
                  </span>
                  {isLoadingDevices ? (
                    <button
                      className="audioDeviceOption"
                      type="button"
                      role="radio"
                      aria-checked={false}
                      disabled
                    >
                      <span className="audioDeviceCheck" aria-hidden="true" />
                      <span className="audioDeviceName">Loading devices…</span>
                    </button>
                  ) : here ? (
                    outputRows.map(({ output, ...state }) => groupRow(output, `${output.deviceName} on ${output.endpointName}`, state))
                  ) : (
                    audioDevices.map((device) => (
                      <button
                        key={device.id || "system-default"}
                        className="audioDeviceOption"
                        type="button"
                        role="radio"
                        aria-checked={isPlayingHere(device.id)}
                        disabled={isChangingDevice}
                        onClick={() => pickHere(device.id, device.name)}
                      >
                        <span className="audioDeviceCheck" aria-hidden="true" />
                        <span
                          className="audioDeviceName"
                          data-tooltip={device.name}
                          data-tooltip-overflow=""
                        >
                          {device.name}
                        </span>
                      </button>
                    ))
                  )}

                </div>
              </>
            )}
            {targetError && (
              <p className="audioControlsError" role="alert">{targetError}</p>
            )}
            {audio?.error && (
              <p className="audioControlsError" role="alert">
                {audio.error}
              </p>
            )}
            {audioDevices.length === 0 && !isLoadingDevices && (
              <p className="audioControlsNote">Enable outputs in Settings.</p>
            )}
            {/* With a server, each output playing has its own slider in the list instead. */}
            {!here && <input
              className="volumeSlider"
              type="range"
              min="0"
              max="100"
              step="1"
              disabled={isLoadingDevices}
              value={volume}
              aria-label="Volume"
              aria-valuetext={`${Math.round(volume)}%`}
              onChange={(event) => {
                latestVolume.current = Number(event.target.value);
                setLocalVolume(selectedDeviceId, Number(event.target.value));
              }}
              style={{ "--volume": `${volume}%` } as CSSProperties}
            />}
          </AudioControlsMenu>
        )}
        <button
          ref={volumeButton}
          id="volumeBtn"
          type="button"
          aria-label={volume <= 0 ? "Volume (muted)" : "Volume"}
          data-tooltip={hasNativeAudio ? "Volume and output device (M mutes)" : "Volume"}
          aria-haspopup={hasNativeAudio ? "dialog" : undefined}
          aria-expanded={hasNativeAudio ? audioMenuOpen : undefined}
          onClick={() => {
            if (!hasNativeAudio) return;
            if (audioMenuOpen) {
              closeAudioMenu();
              return;
            }
            void audio?.refresh();
            setAudioMenuOpen(true);
          }}
        >
          {/* Every level stays loaded, so changing level never waits on an image and blinks out. */}
          <span id="volumeImg" data-level={volumeLevel(volume)} aria-hidden="true">
            {volumeLevels.map(level => <img key={level} src={`/volume-${level}.svg`} alt="" data-level={level} />)}
          </span>
        </button>
        <span className="volumePercentage" aria-live="polite">
          {Math.round(volume)}%
        </span>
      </div>
      <button
        id="queueBtn"
        type="button"
        aria-label="Queue"
        aria-expanded={queueSidebarOpen}
        aria-controls={queueSidebarOpen ? "playbackSidebar" : undefined}
        onClick={onToggleQueue}
        onKeyDown={event => { if (event.key === " ") event.stopPropagation(); }}
        data-tooltip="Queue"
      >
        <img src="/queue.svg" alt="" id="queueImg" />
      </button>
    </div>
  );
}
