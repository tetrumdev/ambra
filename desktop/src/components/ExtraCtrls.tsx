import { useClientConnection } from "../hooks/ClientConnectionContext";
import { isTauri } from "@tauri-apps/api/core";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { AudioControlsMenu } from "./AudioControlsMenu";
import { useAudioSettings } from "../hooks/AudioSettingsContext";
import { visibleOutputs } from "../utils/audioSettings";
import { acceptsPlaybackShortcut } from "../utils/keyboard";
import { matchesShortcut } from "../utils/shortcuts";
import "./ExtraCtrls.css";
import { invokeOn, useEndpoints } from "../utils/playbackTarget";
import { coreCommand, coreOutputs, coreSession, coreSessions, coreView, setCoreSession, subscribeCore, type CoreOutput, type CoreSession } from "../api/core";
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
  const selectedOutput = audio?.settings.outputs.find(
    (output) => output.id === audio.settings.selectedOutputId,
  );
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
  // With more than one session on the server, the menu also switches which one this app controls.
  const currentSession = useSyncExternalStore(subscribeCore, coreSession);
  const [sessions, setSessions] = useState<CoreSession[]>([]);
  const following = core !== null;
  useEffect(() => {
    if (!audioMenuOpen || !following) return;
    let disposed = false;
    void coreSessions().then(list => { if (!disposed) setSessions(list); }).catch(() => {});
    return () => { disposed = true; };
  }, [audioMenuOpen, following]);
  const isPlayingHere = (deviceId: string) => core ? coreOutput?.endpointId === serverConnection?.clientId && coreOutput?.deviceId === deviceId : selectedDeviceId === deviceId;
  const pickHere = (deviceId: string, deviceName: string) => {
    if (core && serverConnection) chooseOutput({ endpointId: serverConnection.clientId, deviceId, endpointName: serverConnection.clientName, deviceName });
    else void selectAudioDevice(deviceId);
  };
  const [remoteVolume, setRemoteVolume] = useState<number | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const targetKey = target ? `${target.endpointId}:${target.deviceId}` : null;
  useEffect(() => {
    setRemoteVolume(null);
    if (!target) return;
    let disposed = false;
    void invokeOn<number>(target, "native_audio_volume").then(value => { if (!disposed) setRemoteVolume(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [targetKey]);
  // The server switched this computer's output; its settings say which one now.
  const ownDeviceId = coreOutput && !target ? coreOutput.deviceId : null;
  useEffect(() => {
    if (ownDeviceId !== null && ownDeviceId !== audio?.settings.selectedOutputId) void audio?.refresh();
  }, [ownDeviceId]);
  const volume = target ? remoteVolume ?? 100
    : volumePreview?.outputId === selectedDeviceId
      ? volumePreview.volume
      : selectedOutput?.volume ?? 100;
  const pendingVolumes = useRef(new Map<string, { outputId: string; volume: number }>());
  const isSendingVolume = useRef(false);
  const remoteVolumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const volumeButton = useRef<HTMLButtonElement>(null);

  const chooseOutput = (output: CoreOutput) => {
    setTargetError(null);
    void coreCommand("output", { output }).catch(error => setTargetError(String(error)));
  };

  // With a server, several outputs can play in step: the box beside each (or a right-click)
  // adds it to the ones playing, or takes it away; choosing the output itself plays there alone.
  const groupOutputs = coreOutputs(core);
  const inGroup = (output: CoreOutput) => groupOutputs.some(member => member.endpointId === output.endpointId && member.deviceId === output.deviceId);
  const toggleInGroup = (output: CoreOutput) => {
    setTargetError(null);
    let next: CoreOutput[];
    if (inGroup(output)) {
      next = groupOutputs.filter(member => !(member.endpointId === output.endpointId && member.deviceId === output.deviceId));
      if (next.length === 0) return;
    } else {
      // A computer plays one of its outputs at a time: another of its outputs takes that one's place.
      next = groupOutputs.some(member => member.endpointId === output.endpointId)
        ? groupOutputs.map(member => member.endpointId === output.endpointId ? output : member)
        : [...groupOutputs, output];
    }
    void coreCommand("outputs", { outputs: next }).catch(error => setTargetError(String(error)));
  };
  const groupRow = (output: CoreOutput, label: string, { syncs, disabled = false, offline = false }: { syncs: boolean; disabled?: boolean; offline?: boolean }) => {
    const checked = inGroup(output);
    const lastOne = checked && groupOutputs.length <= 1;
    const canToggle = syncs && !lastOne;
    const hint = !syncs ? "Update Ambra there to play in sync"
      : lastOne ? "Choose another output to play elsewhere"
      : checked ? "Stop playing here" : "Also play here, in sync";
    return <div
      key={`${output.endpointId}:${output.deviceId}`}
      className="audioDeviceRow"
      onContextMenu={event => {
        event.preventDefault();
        if (canToggle && !disabled) toggleInGroup(output);
      }}
    >
      <button
        className="audioDeviceOption"
        type="button"
        aria-current={checked || undefined}
        aria-label={label}
        disabled={disabled || offline}
        onClick={() => chooseOutput(output)}
      >
        <span className="audioDeviceCheck" aria-hidden="true" />
        <span className="audioDeviceName" data-tooltip={label}>
          {offline ? `${output.deviceName} (offline)` : output.deviceName}
        </span>
      </button>
      <button
        className="audioDeviceToggle"
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={`Play on ${label} in sync`}
        data-tooltip={hint}
        disabled={disabled || !canToggle}
        onClick={() => toggleInGroup(output)}
      >
        <span className="audioDeviceBox" aria-hidden="true" />
      </button>
    </div>;
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
  latestVolume.current = volume;
  const changeVolume = (nextVolume: number) => {
    if (target) {
      latestVolume.current = nextVolume;
      setRemoteVolume(nextVolume);
      // A drag sends its latest level, not every step, over the network.
      clearTimeout(remoteVolumeTimer.current);
      remoteVolumeTimer.current = setTimeout(() => {
        void coreCommand("volume", { volume: nextVolume }).catch(error => setTargetError(String(error)));
      }, 80);
      return;
    }
    if (!audio || audio.loading) return;
    latestVolume.current = nextVolume;
    const next = { outputId: selectedDeviceId, volume: nextVolume };
    setVolumePreview(next);
    pendingVolumes.current.set(next.outputId, next);
    void sendPendingVolume();
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

  const toggleMute = () => {
    const current = latestVolume.current;
    if (current > 0) {
      levelsBeforeMute.set(selectedDeviceId, current);
      changeVolume(0);
    } else {
      changeVolume(levelsBeforeMute.get(selectedDeviceId) ?? UNMUTE_FALLBACK_VOLUME);
    }
  };

  // M mutes and unmutes; Up and Down step the volume, repeating while held.
  const shortcuts = useRef({ toggleMute, changeVolume });
  shortcuts.current = { toggleMute, changeVolume };
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const step = matchesShortcut(event, "volumeUp") ? VOLUME_STEP
        : matchesShortcut(event, "volumeDown") ? -VOLUME_STEP : 0;
      if (step !== 0) {
        if (!acceptsPlaybackShortcut(event, true, true)) return;
        event.preventDefault();
        const next = clampVolume(latestVolume.current + step);
        shortcuts.current.changeVolume(next);
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
      const next = clampVolume(latestVolume.current - Math.sign(event.deltaY) * VOLUME_STEP);
      if (next !== latestVolume.current) shortcuts.current.changeVolume(next);
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
                  {core && sessions.length > 1 && <>
                    <span className="audioDeviceHeading" aria-hidden="true">Session</span>
                    {sessions.map(session => <button
                      key={`session:${session.id}`}
                      className="audioDeviceOption"
                      type="button"
                      role="radio"
                      aria-checked={session.id === currentSession}
                      aria-label={`${session.name} session`}
                      onClick={() => setCoreSession(session.id)}
                    >
                      <span className="audioDeviceCheck" aria-hidden="true" />
                      <span className="audioDeviceName" data-tooltip={session.name} data-tooltip-overflow="">{session.name}</span>
                    </button>)}
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
            {!target && selectedOutput?.presetId && (
              <span className="audioControlsNote">
                DSP:{" "}
                {
                  audio?.settings.presets.find(
                    (preset) => preset.id === selectedOutput.presetId,
                  )?.name
                }
              </span>
            )}
            <input
              className="volumeSlider"
              type="range"
              min="0"
              max="100"
              step="1"
              disabled={isLoadingDevices}
              value={volume}
              aria-label="Volume"
              aria-valuetext={`${Math.round(volume)}%`}
              onChange={(event) => changeVolume(Number(event.target.value))}
              style={{ "--volume": `${volume}%` } as CSSProperties}
            />
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
        aria-label={queueSidebarOpen === undefined ? "Queue" : "Playback sidebar"}
        aria-expanded={queueSidebarOpen}
        aria-controls={queueSidebarOpen ? "playbackSidebar" : undefined}
        onClick={onToggleQueue}
        onKeyDown={event => { if (event.key === " ") event.stopPropagation(); }}
        data-tooltip={queueSidebarOpen === undefined ? "Queue" : "Playback sidebar"}
      >
        <img src="/queue.svg" alt="" id="queueImg" />
      </button>
    </div>
  );
}
