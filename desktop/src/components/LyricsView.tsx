import { useEffect, useMemo, useRef, useState } from "react";
import { trackLyrics } from "../api/server";
import type { LyricAnnotation, LyricLine, TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import type { PlaybackClock } from "../utils/playbackClock";
import { detailedLine, focusLyric, lyricActive, segmentProgress } from "../utils/lyricsTiming";
import "./LyricsView.css";

type LyricsViewProps = {
  track: Track | undefined;
  clock: PlaybackClock;
  playing: boolean;
};

type Row = { id: string; line: LyricLine; kind: "lead" | "background" | "translation" | "romanization"; language?: string | null };

function annotationLine(annotation: LyricAnnotation, parent: LyricLine): LyricLine {
  const starts = annotation.segments.flatMap(segment => segment.startMs === null ? [] : [segment.startMs]);
  const ends = annotation.segments.flatMap(segment => segment.endMs === null ? [] : [segment.endMs]);
  return { ...parent, text: annotation.segments.map(segment => segment.text).join(""), segments: annotation.segments,
    startMs: starts.length ? Math.min(...starts) : parent.startMs,
    endMs: ends.length ? Math.max(...ends) : parent.endMs };
}

function lyricRows(lyrics: TrackLyrics): Row[][] {
  return lyrics.lines.map((line, index) => {
    const rows: Row[] = [{ id: String(index), line, kind: "lead" }];
    const addAnnotations = (line: LyricLine, prefix: string) => {
      for (const kind of ["romanization", "translation"] as const) {
        const annotations = kind === "translation" ? line.translations : line.romanization;
        annotations.forEach((annotation, index) => rows.push({ id: `${prefix}-${kind}-${index}`, line: annotationLine(annotation, line), kind, language: annotation.language }));
      }
    };
    addAnnotations(line, String(index));
    line.backgroundVocals.forEach((background, backgroundIndex) => {
      const id = `${index}-bg-${backgroundIndex}`;
      rows.push({ id, line: background, kind: "background" });
      addAnnotations(background, id);
    });
    return rows;
  });
}

function LyricGroups({ lyrics, groups }: { lyrics: TrackLyrics; groups: Row[][] }) {
  const singerIds = lyrics.singers.map(singer => singer.id);
  for (const row of groups.flat()) {
    if (row.line.singer && !singerIds.includes(row.line.singer)) singerIds.push(row.line.singer);
    for (const segment of row.line.segments) {
      if (segment.singer && !singerIds.includes(segment.singer)) singerIds.push(segment.singer);
    }
  }
  return (
    <div className="lyricsLines">
      {groups.map((rows, index) => (
        <div className="lyricGroup" data-group={index} key={index}>
          {rows.map(({ id, line, kind, language }) => {
            const singerIndex = line.singer ? singerIds.indexOf(line.singer) : 0;
            const voices = [...new Set([line.singer, ...line.segments.map(segment => segment.singer)].filter((id): id is string => id !== null))];
            const voiceName = (id: string) => lyrics.singers.find(singer => singer.id === id)?.name ?? `Voice ${singerIds.indexOf(id) + 1}`;
            return (
              <div key={id} className={`lyricRow lyricRow-${kind}`} data-singer-side={singerIndex % 2 === 1 ? "alternate" : "primary"}>
                {singerIds.length > 1 && (kind === "lead" || kind === "background") && voices.length > 0
                  && <span className="lyricSinger">{voices.map(voiceName).join(" / ")}</span>}
                <p className="lyricLine" data-row={id} data-detail={detailedLine(line)} dir="auto" lang={language ?? undefined}>
                  {line.segments.map((segment, segmentIndex) => (
                    <span key={segmentIndex} className="lyricSegment" title={segment.singer && voices.length > 1 ? voiceName(segment.singer) : undefined}>{segment.text}</span>
                  ))}
                  {!line.text && "\u00a0"}
                </p>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SyncedLyrics({ lyrics, clock, playing }: { lyrics: TrackLyrics; clock: PlaybackClock; playing: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => lyricRows(lyrics), [lyrics]);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rows = groups.flat().map(row => {
      const element = container.querySelector<HTMLElement>(`[data-row="${row.id}"]`)!;
      return { ...row, element, detailed: detailedLine(row.line),
        segments: Array.from(element.querySelectorAll<HTMLElement>(".lyricSegment")), active: false };
    });
    let frame = 0;
    let lastTime = Number.NaN;
    let focus = -1;
    const paint = () => {
      const time = clock.getSmooth() * 1000 + lyrics.offsetMs;
      if (time === lastTime) return;
      const discontinuity = !Number.isFinite(lastTime) || Math.abs(time - lastTime) > 350;
      for (const row of rows) {
        const active = lyricActive(row.line, time);
        const changed = active !== row.active;
        if (changed || discontinuity) {
          row.element.dataset.active = String(active);
          if (active) row.element.setAttribute("aria-current", "true");
          else row.element.removeAttribute("aria-current");
        }
        if (row.detailed && (active || changed || discontinuity)) {
          row.line.segments.forEach((segment, index) => {
            const element = row.segments[index];
            if (!element) return;
            const progress = segmentProgress(segment, time);
            element.style.setProperty("--lyric-progress", `${(progress * 100).toFixed(2)}%`);
            element.dataset.active = String(active && lyricActive(segment, time));
          });
        }
        row.active = active;
      }
      const next = focusLyric(lyrics.lines, time);
      if (next >= 0 && next !== focus) {
        const group = container.querySelector<HTMLElement>(`[data-group="${next}"]`);
        if (group) container.scrollTo({
          top: group.offsetTop - container.clientHeight / 2 + group.offsetHeight / 2,
          behavior: reducedMotion || discontinuity ? "instant" : "smooth",
        });
      }
      focus = next;
      lastTime = time;
    };
    const animate = () => { paint(); frame = requestAnimationFrame(animate); };
    const unsubscribe = clock.subscribe(paint);
    paint();
    if (playing) frame = requestAnimationFrame(animate);
    return () => { unsubscribe(); cancelAnimationFrame(frame); };
  }, [lyrics, groups, clock, playing]);

  return (
    <div className="lyricsViewport" ref={viewport} tabIndex={0} aria-label="Synced lyrics" lang={lyrics.language ?? undefined}>
      <LyricGroups lyrics={lyrics} groups={groups} />
    </div>
  );
}

const sources = { amll: "AMLL TTML DB", "lrc.red": "lrc.red", lrclib: "LRCLIB" };

export function LyricsView({ track, clock, playing }: LyricsViewProps) {
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
  }, [track?.globalId, track?.name, track?.artist, track?.album, track?.durationSeconds,
    track?.isrc, track?.version, track?.providerTrackId, attempt]);

  const unavailableDuringFailure = lyrics?.status === "unavailable" && lyrics.failedProviders.length > 0;
  return (
    <main id="lyricsPage" aria-label="Lyrics">
      <header className="lyricsHeading">
        <h1>{track?.name ?? "Lyrics"}</h1>
        {track && <p>{track.artist}</p>}
      </header>
      {!track ? <p className="lyricsMessage" role="status">Play a song to see its lyrics.</p>
        : error || unavailableDuringFailure ? <div className="lyricsMessage" role="alert">
          <p>Could not load lyrics. Try again.</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>
        </div>
        : !lyrics ? <p className="lyricsMessage" role="status">Loading lyrics…</p>
        : lyrics.status === "instrumental" ? <p className="lyricsMessage" role="status">Instrumental — this song has no lyrics.</p>
        : lyrics.status === "unavailable" ? <p className="lyricsMessage" role="status">No lyrics available for this song.</p>
        : lyrics.sync !== "none" ? <SyncedLyrics lyrics={lyrics} clock={clock} playing={playing} />
        : <div className="lyricsViewport lyricsPlain" tabIndex={0} aria-label="Unsynced lyrics" lang={lyrics.language ?? undefined}>
          <p className="lyricsSyncNote">Timing unavailable</p>
          <LyricGroups lyrics={lyrics} groups={lyricRows(lyrics)} />
        </div>}
      {lyrics?.status === "lyrics" && lyrics.source && <span className="lyricsCredit">Lyrics from {sources[lyrics.source]}</span>}
    </main>
  );
}
