import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import "./ExtraCtrls.css";

type ExtraCtrlsProps = {
  onOpenQueue?: () => void;
};

export function ExtraCtrls({ onOpenQueue }: ExtraCtrlsProps) {
  const showAudioModeToggle = import.meta.env.DEV && isTauri();
  const [exclusiveMode, setExclusiveMode] = useState<boolean | null>(null);
  const [isChangingMode, setIsChangingMode] = useState(false);

  useEffect(() => {
    if (!showAudioModeToggle) return;

    let disposed = false;
    void invoke<boolean>("native_audio_exclusive_mode")
      .then((enabled) => {
        if (!disposed) setExclusiveMode(enabled);
      })
      .catch((error) =>
        console.warn("Could not read the native audio mode:", error),
      );

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

  return (
    <div id="extraCtrls">
      {showAudioModeToggle && (
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
      )}
      <button id="queueBtn" type="button" onClick={onOpenQueue}>
        <img src="/queue.svg" alt="Queue" id="queueImg" />
      </button>
    </div>
  );
}
