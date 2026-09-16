import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import "./ExtraCtrls.css";

type ExtraCtrlsProps = {
  onOpenQueue?: () => void;
};

type NativeAudioDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

export function ExtraCtrls({ onOpenQueue }: ExtraCtrlsProps) {
  const hasNativeAudio = isTauri();
  const showGlobalVolumeControl = false;
  const showAudioModeToggle = import.meta.env.DEV && hasNativeAudio;
  const [exclusiveMode, setExclusiveMode] = useState<boolean | null>(null);
  const [isChangingMode, setIsChangingMode] = useState(false);
  const [audioDevices, setAudioDevices] = useState<NativeAudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [isChangingDevice, setIsChangingDevice] = useState(false);
  const [volume, setVolume] = useState<number | null>(null);
  const pendingVolume = useRef<number | null>(null);
  const isSendingVolume = useRef(false);
  const [volumeClicked, setVolumeClicked] = useState(false);

  useEffect(() => {
    if (!hasNativeAudio || !showGlobalVolumeControl) return;

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
  }, [hasNativeAudio, showGlobalVolumeControl]);

  useEffect(() => {
    if (!showAudioModeToggle) return;

    let disposed = false;
    setIsLoadingDevices(true);
    void invoke<boolean>("native_audio_exclusive_mode")
      .then((enabled) => {
        if (!disposed) setExclusiveMode(enabled);
      })
      .catch((error) =>
        console.warn("Could not read the native audio mode:", error),
      );
    void invoke<NativeAudioDevice[]>("list_native_audio_devices")
      .then((devices) => {
        if (!disposed) setAudioDevices(devices);
      })
      .catch((error) =>
        console.warn("Could not list native audio devices:", error),
      )
      .finally(() => {
        if (!disposed) setIsLoadingDevices(false);
      });

    return () => {
      disposed = true;
    };
  }, [showAudioModeToggle]);

  const toggleExclusiveMode = async () => {
    if (exclusiveMode === null || isChangingMode) return;

    const enabled = !exclusiveMode;
    setIsChangingMode(true);
    try {
      await invoke("set_native_audio_exclusive_mode", { enabled });
      setExclusiveMode(enabled);
    } catch (error) {
      console.warn("Could not change the native audio mode:", error);
    } finally {
      setIsChangingMode(false);
    }
  };

  const selectAudioDevice = async (deviceId: string) => {
    if (isChangingDevice) return;

    setIsChangingDevice(true);
    try {
      await invoke("select_native_audio_device", {
        deviceId: deviceId || null,
      });
      setSelectedDeviceId(deviceId);
    } catch (error) {
      console.warn("Could not change the native audio device:", error);
    } finally {
      setIsChangingDevice(false);
    }
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

  return (
    <div
      id="extraCtrls"
      data-volume-clicked={volumeClicked ? "" : undefined}
    >
      {hasNativeAudio && showGlobalVolumeControl && (
        <input
          className="globalVolumeControl"
          type="range"
          min="0"
          max="100"
          step="1"
          value={volume ?? 100}
          disabled={volume === null}
          aria-label="Global volume"
          title={`${volume?.toFixed(0) ?? "100"}%`}
          onChange={(event) => changeVolume(Number(event.target.value))}
        />
      )}
      <div className="volumeControlContainer">
        {showAudioModeToggle && (
          <div className="devAudioControls">
            <select
              aria-label="Audio output device"
              value={selectedDeviceId}
              disabled={isLoadingDevices || isChangingDevice}
              onChange={(event) => void selectAudioDevice(event.target.value)}
            >
              <option value="">
                {isLoadingDevices ? "Loading devices…" : "System Default"}
              </option>
              {audioDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.isDefault ? " (Default)" : ""}
                </option>
              ))}
            </select>
            <button
              className="devAudioModeToggle"
              type="button"
              aria-pressed={exclusiveMode === true}
              disabled={exclusiveMode === null || isChangingMode}
              title={
                exclusiveMode === null
                  ? "Reading the CoreAudio output mode…"
                  : exclusiveMode
                    ? "CoreAudio exclusive mode is on. Click for system output."
                    : "CoreAudio system output is on. Click for exclusive mode."
              }
              onClick={() => void toggleExclusiveMode()}
            >
              {exclusiveMode === null
                ? "…"
                : exclusiveMode
                  ? "EXCLUSIVE"
                  : "SYSTEM OUTPUT"}
            </button>
          </div>
        )}
        <button
          id="volumeBtn"
          type="button"
          aria-label="Volume"
          aria-expanded={volumeClicked}
          onClick={() => setVolumeClicked((clicked) => !clicked)}
        >
          <img src="/volumeIconHigh.svg" alt="" id="volumeImg" />
        </button>
      </div>
      <button id="queueBtn" type="button" onClick={onOpenQueue}>
        <img src="/queue.svg" alt="Queue" id="queueImg" />
      </button>
    </div>
  );
}
