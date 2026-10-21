import { isTauri } from "@tauri-apps/api/core";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { AudioControlsMenu } from "./AudioControlsMenu";
import { useAudioSettings } from "../hooks/AudioSettingsContext";
import { visibleOutputs } from "../utils/audioSettings";
import "./ExtraCtrls.css";

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
  const volume = volumePreview?.outputId === selectedDeviceId
    ? volumePreview.volume
    : selectedOutput?.volume ?? 100;
  const pendingVolumes = useRef(new Map<string, { outputId: string; volume: number }>());
  const isSendingVolume = useRef(false);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const volumeButton = useRef<HTMLButtonElement>(null);

  const selectAudioDevice = async (deviceId: string) => {
    if (!audio || audio.saving) return;
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

  const changeVolume = (nextVolume: number) => {
    if (!audio || audio.loading) return;
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

  return (
    <div id="extraCtrls">
      <div className="volumeControlContainer">
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
                    Output
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
                        aria-checked={selectedDeviceId === device.id}
                        disabled={isChangingDevice}
                        onClick={() => void selectAudioDevice(device.id)}
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
                </div>
              </>
            )}
            {audio?.error && (
              <p className="audioControlsError" role="alert">
                {audio.error}
              </p>
            )}
            {audioDevices.length === 0 && !isLoadingDevices && (
              <p className="audioControlsNote">Enable outputs in Settings.</p>
            )}
            {selectedOutput?.presetId && (
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
          aria-label="Volume"
          data-tooltip={hasNativeAudio ? "Volume and output device" : "Volume"}
          aria-haspopup={hasNativeAudio ? "dialog" : undefined}
          aria-expanded={hasNativeAudio ? audioMenuOpen : undefined}
          onClick={() => {
            if (hasNativeAudio) {
              if (!audioMenuOpen) void audio?.refresh();
              setAudioMenuOpen((open) => !open);
            }
          }}
        >
          <img src="/volume-high.svg" alt="" id="volumeImg" />
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
