import { useEffect, useRef, useState } from "react";
import { trackLyrics, type LyricWord, type TrackLyrics } from "../api/server";
import type { Track } from "../types/music";
import { usePlaybackTime, type PlaybackClock } from "../utils/playbackClock";
import "./LyricsView.css";

type LyricsViewProps = {
  track: Track | undefined;
  clock: PlaybackClock;
};

function isActive(segment: LyricWord, timeMs: number) {
  return timeMs >= segment.startMs && (segment.endMs === null || timeMs < segment.endMs);
}

function SyncedLyrics({ lyrics, clock }: { lyrics: TrackLyrics; clock: PlaybackClock }) {
  const viewport = useRef<HTMLDivElement>(null);
  // Only rerender at timing boundaries, rather than on every playback tick.
  const active = usePlaybackTime(clock, time => JSON.stringify(lyrics.lines.flatMap((line, index) =>
    isActive(line, time * 1000)
      ? [[index, line.words.flatMap((word, wordIndex) => isActive(word, time * 1000) ? [wordIndex] : [])]]
      : [],
  )));
  const activeLines = new Map<number, number[]>(JSON.parse(active));
  const focusLine = [...activeLines.keys()].find(index => lyrics.lines[index].text.trim()) ?? -1;

  useEffect(() => {
    const container = viewport.current;
    const line = container?.querySelector<HTMLElement>(`[data-line="${focusLine}"]`);
    if (!container || !line) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({
      top: line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2,
      behavior: reducedMotion ? "instant" : "smooth",
    });
  }, [focusLine]);

  return (
    <div className="lyricsViewport" ref={viewport} tabIndex={0} aria-label="Synced lyrics">
      <div className="lyricsLines">
        {lyrics.lines.map((line, index) => {
          const lineActive = activeLines.has(index) && Boolean(line.text.trim());
          return (
            <p
              key={index}
              className="lyricLine"
              data-line={index}
              data-active={lineActive}
              data-word-sync={line.words.length > 0}
              aria-current={lineActive ? "true" : undefined}
            >
              {line.words.length > 0 ? line.words.map((word, wordIndex) => (
                <span
                  key={wordIndex}
                  className="lyricWord"
                  data-active={lineActive && activeLines.get(index)?.includes(wordIndex)}
                >{word.text}</span>
              )) : line.text || "\u00a0"}
            </p>
          );
        })}
      </div>
    </div>
  );
}

export function LyricsView({ track, clock }: LyricsViewProps) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLyrics(null);
    setError(false);
    if (track) {
      void trackLyrics(track, controller.signal).then(result => {
        if (!controller.signal.aborted) setLyrics(result);
      }).catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    }
    return () => controller.abort();
  }, [track?.globalId, track?.name, track?.artist, track?.album, track?.durationSeconds, attempt]);

  return (
    <main id="lyricsPage" aria-label="Lyrics">
      <header className="lyricsHeading">
        <h1>{track?.name ?? "Lyrics"}</h1>
        {track && <p>{track.artist}</p>}
      </header>
      {!track ? <p className="lyricsMessage" role="status">Play a song to see its lyrics.</p>
        : error ? <div className="lyricsMessage" role="alert">
          <p>Could not load lyrics. Try again.</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>
        </div>
        : !lyrics ? <p className="lyricsMessage" role="status">Loading lyrics…</p>
        : lyrics.status === "instrumental" ? <p className="lyricsMessage" role="status">Instrumental — this song has no lyrics.</p>
        : lyrics.status === "unavailable" ? <p className="lyricsMessage" role="status">No lyrics available for this song.</p>
        : lyrics.lines.length > 0 ? <SyncedLyrics lyrics={lyrics} clock={clock} />
        : <div className="lyricsViewport lyricsPlain" tabIndex={0} aria-label="Unsynced lyrics">
          <p className="lyricsSyncNote">Timing unavailable</p>
          <div>{lyrics.plainLyrics}</div>
        </div>}
      {lyrics?.status === "lyrics" && <span className="lyricsCredit">Lyrics from LRCLIB</span>}
    </main>
  );
}
