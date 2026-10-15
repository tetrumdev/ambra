import { useEffect, useMemo, useRef, useState } from "react";
import { thumbnailArtwork, trackLyrics } from "../api/server";
import type { LyricAnnotation, LyricLine, TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import type { PlaybackClock } from "../utils/playbackClock";
import type { LyricMotion } from "../utils/preferences";
import { cachedBigscreenArtwork, preloadBigscreenArtwork } from "../utils/artworkImages";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { detailedLine, focusLyric, lyricActive, segmentProgress } from "../utils/lyricsTiming";
import "./LyricsView.css";

type LyricsViewProps = {
  track: Track | undefined;
  clock: PlaybackClock;
  playing: boolean;
  onSeek?: (seconds: number) => void;
  motion?: LyricMotion;
  onMotionChange?: (motion: LyricMotion) => void;
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

function LyricsArtwork({ track }: { track: Track }) {
  const fallback = thumbnailArtwork(track);
  const [cover, setCover] = useState(() => cachedBigscreenArtwork(track) ?? fallback);
  useEffect(() => {
    let cancelled = false;
    setCover(cachedBigscreenArtwork(track) ?? fallback);
    void preloadBigscreenArtwork(track).then(source => {
      if (!cancelled && source) setCover(source);
    });
    return () => { cancelled = true; };
  }, [track.globalId, track.albumId, track.cover, track.fullCover, track.nativeCover, track.provider, track.upc, fallback]);
  return <img id="lyricsArtwork" className="lyricsArtwork" src={cover} alt=""
    onError={() => setCover(cover === fallback ? whiteArtwork : fallback)} />;
}

function LyricGroups({ lyrics, groups, onSeek }: { lyrics: TrackLyrics; groups: Row[][]; onSeek?: (seconds: number) => void }) {
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
            const seekable = onSeek && line.startMs !== null && (kind === "lead" || kind === "background");
            const Line = seekable ? "button" : "p";
            return (
              <div key={id} className={`lyricRow lyricRow-${kind}`} data-singer-side={singerIndex % 2 === 1 ? "alternate" : "primary"}>
                {singerIds.length > 1 && (kind === "lead" || kind === "background") && voices.length > 0
                  && <span className="lyricSinger">{voices.map(voiceName).join(" / ")}</span>}
                <Line className="lyricLine" data-row={id} data-detail={detailedLine(line)} dir="auto" lang={language ?? undefined}
                  type={seekable ? "button" : undefined}
                  title={seekable ? "Seek to this lyric" : undefined}
                  onClick={seekable ? () => onSeek(Math.max(0, (line.startMs! - lyrics.offsetMs) / 1000)) : undefined}>
                  {line.segments.map((segment, segmentIndex) => (
                    <span key={segmentIndex} className="lyricSegment" title={segment.singer && voices.length > 1 ? voiceName(segment.singer) : undefined}>{segment.text}</span>
                  ))}
                  {!line.text && "\u00a0"}
                </Line>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SyncedLyrics({ lyrics, clock, playing, reducedMotion, onSeek }: {
  lyrics: TrackLyrics; clock: PlaybackClock; playing: boolean; reducedMotion: boolean; onSeek?: (seconds: number) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => lyricRows(lyrics), [lyrics]);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const wake = useRef<() => void>(() => {});
  const resume = useRef<() => void>(() => {});

  useEffect(() => { wake.current(); }, [playing]);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const rowGroups = groups.map(groupRows => groupRows.map(row => {
      const element = container.querySelector<HTMLElement>(`[data-row="${row.id}"]`)!;
      return { ...row, element, detailed: detailedLine(row.line),
        segments: Array.from(element.querySelectorAll<HTMLElement>(".lyricSegment")), active: false };
    }));
    const rows = rowGroups.flat();
    const blocks = rowGroups.map((rows, index) => ({
      element: container.querySelector<HTMLElement>(`[data-group="${index}"]`)!,
      rows,
      top: 0, height: 0, active: false,
    }));
    let frame = 0;
    let lastTime = Number.NaN;
    let focus = -1;
    let target = container.scrollTop;
    let velocity = 0;
    let lastFrame = 0;
    let layoutDirty = true;
    let align = true;
    const schedule = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(paint);
    };
    const paint = (now: number) => {
      frame = 0;
      if (document.hidden) return;
      const elapsed = lastFrame ? Math.min((now - lastFrame) / 1000, 0.032) : 1 / 60;
      lastFrame = now;
      const time = clock.getSmooth() * 1000 + lyrics.offsetMs;
      const discontinuity = !Number.isFinite(lastTime) || time < lastTime - 50 || time - lastTime > 350;
      const measured = layoutDirty;
      if (layoutDirty) {
        container.style.setProperty("--lyrics-viewport-height", `${container.clientHeight}px`);
        for (const block of blocks) {
          block.top = block.element.offsetTop;
          block.height = block.element.offsetHeight;
        }
        layoutDirty = false;
      }
      if (time !== lastTime || measured) {
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
              const energy = Math.sin(progress * Math.PI);
              element.style.setProperty("--lyric-feather", `${(energy * 8).toFixed(2)}%`);
              element.style.setProperty("--lyric-energy", energy.toFixed(3));
              element.dataset.active = String(active && lyricActive(segment, time));
            });
          }
          row.active = active;
        }
        let next = focusLyric(lyrics.lines, time);
        if (next < 0) {
          // Keep the last verse in view through instrumental gaps; frame the first line during an intro.
          next = lyrics.lines.reduce((previous, line, index) => line.startMs !== null && line.startMs <= time ? index : previous, -1);
          if (next < 0) next = lyrics.lines.findIndex(line => line.startMs !== null);
        }
        for (const [index, block] of blocks.entries()) {
          const active = block.rows.some(row => row.active);
          if (next !== focus || active !== block.active || discontinuity) {
            const distance = Math.abs(index - next);
            block.element.style.setProperty("--lyric-opacity", String(active || index === next ? 1 : index < next ? 0.28 : Math.max(0.24, 0.72 - distance * 0.13)));
            block.element.style.setProperty("--lyric-blur", `${active || index === next ? 0 : Math.min(1.8, Math.max(0, distance - 1) * 0.6)}px`);
          }
          block.active = active;
        }
        if (next !== focus || measured) align = true;
        focus = next;
        lastTime = time;
      }
      if (followingRef.current && focus >= 0 && align) {
        const block = blocks[focus];
        target = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
          block.top - container.clientHeight * 0.43 + Math.min(block.height, container.clientHeight * 0.4) / 2));
        align = false;
      }
      let moving = false;
      if (followingRef.current) {
        if (reducedMotion || discontinuity) {
          container.scrollTop = target;
          velocity = 0;
        } else {
          // Own the spring instead of relying on WebView-specific smooth-scroll timing.
          const distance = target - container.scrollTop;
          moving = Math.abs(distance) > 0.75 || Math.abs(velocity) > 2;
          if (moving) {
            velocity += (distance * 150 - velocity * 24) * elapsed;
            container.scrollTop += velocity * elapsed;
          } else {
            container.scrollTop = target;
            velocity = 0;
          }
        }
      }
      for (const [index, block] of blocks.entries()) {
        const lag = followingRef.current && !reducedMotion && moving
          ? Math.max(-80, Math.min(80, (target - container.scrollTop) * Math.min(0.32, Math.abs(index - focus) * 0.065))) : 0;
        const transform = lag ? `translate3d(0, ${lag.toFixed(2)}px, 0)` : "";
        if (block.element.style.transform !== transform) block.element.style.transform = transform;
      }
      if (playingRef.current || moving) schedule();
    };
    const hold = () => {
      followingRef.current = false;
      setFollowing(false);
      velocity = 0;
      schedule();
    };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)
        || (event.key === " " && event.target === container)) hold();
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLButtonElement) hold();
    };
    resume.current = () => {
      followingRef.current = true;
      setFollowing(true);
      align = true;
      schedule();
    };
    wake.current = schedule;
    const resize = new ResizeObserver(() => { layoutDirty = true; schedule(); });
    resize.observe(container);
    resize.observe(container.querySelector(".lyricsLines")!);
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = Number.NaN;
      lastFrame = 0;
      schedule();
    };
    const unsubscribe = clock.subscribe(schedule);
    container.addEventListener("wheel", hold, { passive: true });
    container.addEventListener("touchstart", hold, { passive: true });
    container.addEventListener("keydown", onKey);
    container.addEventListener("focusin", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
      resize.disconnect();
      container.removeEventListener("wheel", hold);
      container.removeEventListener("touchstart", hold);
      container.removeEventListener("keydown", onKey);
      container.removeEventListener("focusin", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      wake.current = () => {};
      resume.current = () => {};
    };
  }, [lyrics, groups, clock, reducedMotion]);

  return (
    <>
      <div className="lyricsViewport" ref={viewport} tabIndex={0} data-following={following} aria-label="Synced lyrics" lang={lyrics.language ?? undefined}>
        <LyricGroups lyrics={lyrics} groups={groups} onSeek={onSeek ? seconds => { resume.current(); onSeek(seconds); } : undefined} />
      </div>
      {!following && <button className="lyricsResume" type="button" onClick={() => resume.current()}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 4 8 6-8 6Z" /></svg>
        Back to current line
      </button>}
    </>
  );
}

const sources = { amll: "AMLL TTML DB", "lrc.red": "lrc.red", lrclib: "LRCLIB" };

export function LyricsView({ track, clock, playing, onSeek, motion = "system", onMotionChange }: LyricsViewProps) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [systemReducedMotion, setSystemReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const reducedMotion = motion === "reduced" || (motion === "system" && systemReducedMotion);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

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
    <main id="lyricsPage" aria-label="Lyrics" data-reduced-motion={reducedMotion}>
      <header className="lyricsHeading">
        {track && <LyricsArtwork track={track} />}
        <div className="lyricsTrackInfo">
          <span className="lyricsEyebrow">Lyrics</span>
          <h1>{track?.name ?? "Your music, word for word."}</h1>
          {track && <p>{track.artist}</p>}
          {track?.album && <span className="lyricsAlbum">{track.album}</span>}
        </div>
      </header>
      <section className="lyricsStage" aria-label="Song lyrics">
      {!track ? <p className="lyricsMessage" role="status">Play a song to see its lyrics.</p>
        : error || unavailableDuringFailure ? <div className="lyricsMessage" role="alert">
          <p>Could not load lyrics. Try again.</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>
        </div>
        : !lyrics ? <p className="lyricsMessage" role="status">Loading lyrics…</p>
        : lyrics.status === "instrumental" ? <p className="lyricsMessage" role="status">Instrumental — this song has no lyrics.</p>
        : lyrics.status === "unavailable" ? <p className="lyricsMessage" role="status">No lyrics available for this song.</p>
        : lyrics.sync !== "none" ? <SyncedLyrics lyrics={lyrics} clock={clock} playing={playing} reducedMotion={reducedMotion} onSeek={onSeek} />
        : <div className="lyricsViewport lyricsPlain" tabIndex={0} aria-label="Unsynced lyrics" lang={lyrics.language ?? undefined}>
          <p className="lyricsSyncNote">Timing unavailable</p>
          <LyricGroups lyrics={lyrics} groups={lyricRows(lyrics)} />
        </div>}
      <footer className="lyricsFooter">
        {lyrics?.status === "lyrics" && <div className="lyricsAttribution">
          <span className="lyricsSyncLabel">{lyrics.sync === "none" ? "Unsynced lyrics" : lyrics.hasWordSync ? "Word by word" : "Synced lyrics"}</span>
          {lyrics.source && <span className="lyricsCredit">Lyrics from {sources[lyrics.source]}</span>}
        </div>}
        {onMotionChange && <label className="lyricsMotion">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 8v4m4-8v12m6-12v12m4-8v4" /></svg>
          <select aria-label="Lyric motion" title="Lyric motion" value={motion} onChange={event => onMotionChange(event.target.value as LyricMotion)}>
            <option value="system">System ({systemReducedMotion ? "reduced" : "full"})</option>
            <option value="full">Full motion</option>
            <option value="reduced">Reduced motion</option>
          </select>
        </label>}
      </footer>
      </section>
    </main>
  );
}
