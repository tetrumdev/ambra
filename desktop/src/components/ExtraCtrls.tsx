import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  useEffect,
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
  onToggleLyrics?: () => void;
  lyricsActive?: boolean;
};

export function ExtraCtrls({ onOpenQueue, onToggleLyrics, lyricsActive = false }: ExtraCtrlsProps) {
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
  const [volume, setVolume] = useState(100);
  const pendingVolume = useRef<number | null>(null);
  const isSendingVolume = useRef(false);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const volumeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!hasNativeAudio) return;

    let disposed = false;
    void invoke<number>("native_audio_volume")
      .then((currentVolume) => {
        if (!disposed) setVolume(currentVolume);
      })
      .catch((error) =>
        console.warn("Could not read the native audio volume:", error),
      );

    return () => {
      disposed = true;
    };
  }, [hasNativeAudio]);

  const selectAudioDevice = async (deviceId: string) => {
    if (!audio || audio.saving) return;
    await audio.update((current) => ({
      ...current,
      selectedOutputId: deviceId,
    }));
  };

  const sendPendingVolume = async () => {
    if (isSendingVolume.current) return;

    isSendingVolume.current = true;
    while (pendingVolume.current !== null) {
      const nextVolume = pendingVolume.current;
      pendingVolume.current = null;
      try {
        await invoke("set_native_audio_volume", { volume: nextVolume });
      } catch (error) {
        console.warn("Could not change the native audio volume:", error);
      }
    }
    isSendingVolume.current = false;
  };

  const changeVolume = (nextVolume: number) => {
    setVolume(nextVolume);
    pendingVolume.current = nextVolume;
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
          <img src="/volumeIconHigh.svg" alt="" id="volumeImg" />
        </button>
        <span className="volumePercentage" aria-live="polite">
          {Math.round(volume)}%
        </span>
      </div>
      <button
        id="lyricsBtn"
        type="button"
        onClick={onToggleLyrics}
        aria-label="Lyrics"
        aria-pressed={lyricsActive}
        aria-controls="lyricsPage"
        data-tooltip="Lyrics"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M4 5h12M4 10h9M4 15h6M18 10v8M18 10l4-1v7" />
          <ellipse cx="16" cy="18" rx="2" ry="1.5" />
          <ellipse cx="20" cy="16" rx="2" ry="1.5" />
        </svg>
      </button>
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
