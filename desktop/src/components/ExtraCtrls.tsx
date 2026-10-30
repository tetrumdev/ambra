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
import { visibleOutputs } from "../utils/audioSettings";
import { acceptsPlaybackShortcut } from "../utils/keyboard";
import { matchesShortcut } from "../utils/shortcuts";
import "./ExtraCtrls.css";
import { invokeOn, useEndpoints } from "../utils/playbackTarget";
import { coreCommand, coreView, subscribeCore, type CoreOutput } from "../api/core";
import { serverConnection } from "../api/serverConnection";

/** How far Up and Down change the volume, in percent. */
const VOLUME_STEP = 5;
/** Percent per pixel scrolled: one mouse wheel notch is about 100 pixels, so it moves one step. */
const WHEEL_VOLUME_PER_PIXEL = VOLUME_STEP / 100;
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
  onOpenQueue?: () => void;
};

export function ExtraCtrls({ onOpenQueue }: ExtraCtrlsProps) {
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

  // Scrolling over the volume control glides the level; a trackpad moves it in fine steps.
  const volumeControl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const control = volumeControl.current;
    if (!control) return;
    const handleWheel = (event: WheelEvent) => {
      // The output list in the open menu scrolls as usual.
      if (event.target instanceof Element && event.target.closest(".audioDeviceList")) return;
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * 400 : event.deltaY;
      if (pixels === 0) return;
      event.preventDefault();
      const next = clampVolume(latestVolume.current - pixels * WHEEL_VOLUME_PER_PIXEL);
      if (next !== latestVolume.current) shortcuts.current.changeVolume(Math.round(next * 10) / 10);
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
                  role="radiogroup"
                  aria-label="Audio output device"
                  onKeyDown={moveDeviceFocus}
                >
                  <span className="audioDeviceHeading" aria-hidden="true">
                    {core && endpoints.length ? "This computer" : "Output"}
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
                          {audio?.devices.find(
                            (connected) => connected.id === device.id,
                          )?.isDefault
                            ? " (Default)"
                            : ""}
                        </span>
                      </button>
                    ))
                  )}
                  {endpoints.map(endpoint => <Fragment key={endpoint.id}>
                    <span className="audioDeviceHeading" aria-hidden="true">{endpoint.name}</span>
                    {endpoint.devices.map(device => <button
                      key={`${endpoint.id}:${device.id}`}
                      className="audioDeviceOption"
                      type="button"
                      role="radio"
                      aria-checked={target?.endpointId === endpoint.id && target.deviceId === device.id}
                      aria-label={`${device.name} on ${endpoint.name}`}
                      onClick={() => chooseOutput({ endpointId: endpoint.id, endpointName: endpoint.name, deviceId: device.id, deviceName: device.name })}
                    >
                      <span className="audioDeviceCheck" aria-hidden="true" />
                      <span className="audioDeviceName" data-tooltip={device.name} data-tooltip-overflow="">{device.name}</span>
                    </button>)}
                  </Fragment>)}
                  {target && !endpoints.some(endpoint => endpoint.id === target.endpointId) && <>
                    <span className="audioDeviceHeading" aria-hidden="true">{target.endpointName}</span>
                    <button className="audioDeviceOption" type="button" role="radio" aria-checked disabled>
                      <span className="audioDeviceCheck" aria-hidden="true" />
                      <span className="audioDeviceName">{target.deviceName} (offline)</span>
                    </button>
                  </>}
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
            if (hasNativeAudio) {
              if (!audioMenuOpen) void audio?.refresh();
              setAudioMenuOpen((open) => !open);
            }
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
        onClick={onOpenQueue}
        data-tooltip="Queue"
      >
        <img src="/queue.svg" alt="Queue" id="queueImg" />
      </button>
    </div>
  );
}
