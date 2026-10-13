import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createPlaybackClock } from "../src/utils/playbackClock";
import { NowPlayingBar } from "../src/components/NowPlayingBar";
import type { AudioDeckController } from "../src/hooks/useAudioPlayer";
import type { Track } from "../src/types/music";
import { track } from "./searchFixture";

const noop = () => {};
const audioDecks: AudioDeckController = {
  firstAudioRef: { current: null }, secondAudioRef: { current: null },
  onLoadedMetadata: noop, onDurationChange: noop, onTimeUpdate: noop,
  onCanPlay: noop, onPlaying: noop, onPause: noop, onEnded: noop,
};

function render(variant: "compact" | "expanded", currentTrack?: Track, playbackError?: string) {
  return renderToStaticMarkup(<NowPlayingBar
    variant={variant} track={currentTrack} onOpenEntity={noop} showAudioQuality={true}
    clock={createPlaybackClock()} duration={180} isPlaying={false} audioDecks={audioDecks}
    playbackError={playbackError}
    onPrevious={noop} onTogglePlayback={noop} onNext={noop} onSeek={noop}
    audioQuality={{ codec: "flac", bitDepth: 24, sampleRateHz: 96000, channels: 2, bitrateKbps: 2642, bitrateIsEstimate: true }}
  />);
}

for (const variant of ["compact", "expanded"] as const) {
  test(`${variant} player exposes accessible quality details`, () => {
    const markup = render(variant, track("local:1", "local"));
    expect(markup).toContain('aria-label="Audio quality"');
    expect(markup).toContain("Hi-Res Lossless");
    expect(markup).toContain("FLAC · 24-bit · 96 kHz · Stereo · ≈2,642 kbps");
    expect(markup).toContain('aria-label="Playback position"');
  });
  test(`${variant} empty player does not retain quality from a previous track`, () => {
    const markup = render(variant);
    expect(markup).not.toContain('aria-label="Audio quality"');
    expect(markup).toContain("Nothing Playing");
  });
  test(`${variant} player shows service failures instead of silently waiting`, () => {
    const message = "Tidal is not connected. Sign in from the Library services menu.";
    const markup = render(variant, track("tidal:1", "tidal"), message);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(message);
    expect(render(variant, undefined, message)).not.toContain('role="alert"');
  });
}
