import type { AudioDeckController } from "../hooks/useAudioPlayer";

type AudioDecksProps = {
  controller: AudioDeckController;
};

export function AudioDecks({ controller }: AudioDecksProps) {
  return (
    <>
      <audio
        ref={controller.firstAudioRef}
        preload="metadata"
        onLoadedMetadata={(event) => controller.onLoadedMetadata(0, event)}
        onDurationChange={(event) => controller.onDurationChange(0, event)}
        onTimeUpdate={(event) => controller.onTimeUpdate(0, event)}
        onPlay={() => controller.onPlay(0)}
        onPause={() => controller.onPause(0)}
        onEnded={() => controller.onEnded(0)}
      />
      <audio
        ref={controller.secondAudioRef}
        preload="metadata"
        onLoadedMetadata={(event) => controller.onLoadedMetadata(1, event)}
        onDurationChange={(event) => controller.onDurationChange(1, event)}
        onTimeUpdate={(event) => controller.onTimeUpdate(1, event)}
        onPlay={() => controller.onPlay(1)}
        onPause={() => controller.onPause(1)}
        onEnded={() => controller.onEnded(1)}
      />
    </>
  );
}
