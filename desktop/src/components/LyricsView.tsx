import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { thumbnailArtwork } from "../api/server";
import type { LyricAnnotation, LyricLine, TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import type { PlaybackClock } from "../utils/playbackClock";
import type { LyricMotion } from "../utils/preferences";
import {
  cachedBigscreenArtwork,
  preloadBigscreenArtwork,
} from "../utils/artworkImages";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { cachedLyrics, loadLyrics } from "../utils/lyricsCache";
import {
  detailedLine,
  focusLyric,
  lyricActive,
} from "../utils/lyricsTiming";
import {
  animateLetter,
  letterHead,
  letterMotion,
  restLetter,
} from "../utils/lyricsMotion";
import "./LyricsView.css";

type LyricsViewProps = {
  track: Track | undefined;
  clock: PlaybackClock;
  playing: boolean;
  onSeek?: (seconds: number) => void;
  motion?: LyricMotion;
  onMotionChange?: (motion: LyricMotion) => void;
};

type Row = {
  id: string;
  line: LyricLine;
  kind: "lead" | "background" | "translation" | "romanization";
  language?: string | null;
};

function annotationLine(
  annotation: LyricAnnotation,
  parent: LyricLine,
): LyricLine {
  const starts = annotation.segments.flatMap((segment) =>
    segment.startMs === null ? [] : [segment.startMs],
  );
  const ends = annotation.segments.flatMap((segment) =>
    segment.endMs === null ? [] : [segment.endMs],
  );
  return {
    ...parent,
    text: annotation.segments.map((segment) => segment.text).join(""),
    segments: annotation.segments,
    startMs: starts.length ? Math.min(...starts) : parent.startMs,
    endMs: ends.length ? Math.max(...ends) : parent.endMs,
  };
}

function lyricRows(lyrics: TrackLyrics): Row[][] {
  return lyrics.lines.map((line, index) => {
    const rows: Row[] = [{ id: String(index), line, kind: "lead" }];
    const addAnnotations = (line: LyricLine, prefix: string) => {
      for (const kind of ["romanization", "translation"] as const) {
        const annotations =
          kind === "translation" ? line.translations : line.romanization;
        annotations.forEach((annotation, index) =>
          rows.push({
            id: `${prefix}-${kind}-${index}`,
            line: annotationLine(annotation, line),
            kind,
            language: annotation.language,
          }),
        );
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

type Block =
  | { kind: "lines"; id: string; line: number; rows: Row[] }
  | { kind: "pause"; id: string; startMs: number; endMs: number };

// Gaps at least this long show breathing dots instead of holding the last line.
const PAUSE_MIN_MS = 4000;
/** Blur by distance from the focused group, in px. */
const blurSteps = [0, 0, 0.8, 1.4, 2];

function lineEnd(line: LyricLine): number | null {
  const ends = [line.endMs, ...line.backgroundVocals.map((vocal) => vocal.endMs)]
    .filter((end): end is number => end !== null);
  return ends.length ? Math.max(...ends) : null;
}

function lyricBlocks(lyrics: TrackLyrics, timed: boolean): Block[] {
  const groups = lyricRows(lyrics);
  if (!timed)
    return groups.map((rows, line) => ({ kind: "lines", id: String(line), line, rows }));
  const blocks: Block[] = [];
  // An unknown end means the line may run until the next one, so no pause is inferred.
  let previousEnd = 0;
  lyrics.lines.forEach((line, index) => {
    const empty = !line.text.trim() && line.backgroundVocals.length === 0;
    if (line.startMs !== null && line.startMs - previousEnd >= PAUSE_MIN_MS)
      blocks.push({ kind: "pause", id: `pause-${index}`, startMs: previousEnd, endMs: line.startMs });
    if (empty) {
      // Synced formats mark instrumental breaks with blank lines.
      if (line.startMs !== null) previousEnd = line.startMs;
      return;
    }
    blocks.push({ kind: "lines", id: String(index), line: index, rows: groups[index] });
    previousEnd = lineEnd(line) ?? Number.POSITIVE_INFINITY;
  });
  return blocks;
}

type TextSegmenter = {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};
const IntlSegmenter = (
  Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: "grapheme" | "word" },
    ) => TextSegmenter;
  }
).Segmenter;
const unspacedScript =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

function graphemes(text: string, lang?: string): string[] {
  return IntlSegmenter
    ? Array.from(new IntlSegmenter(lang, { granularity: "grapheme" }).segment(text), (part) => part.segment)
    : Array.from(text);
}

/** Splits text into unbreakable words; scripts without spaces fall back to dictionary words. */
function wordPieces(text: string, lang?: string): string[] {
  return text.split(/(\s+)/).flatMap((token) => {
    if (!token || /^\s+$/.test(token) || !IntlSegmenter || !unspacedScript.test(token))
      return token ? [token] : [];
    const pieces: string[] = [];
    for (const part of new IntlSegmenter(lang, { granularity: "word" }).segment(token)) {
      // Keep punctuation on the word before it so it never starts a line.
      if (!part.isWordLike && pieces.length) pieces[pieces.length - 1] += part.segment;
      else pieces.push(part.segment);
    }
    return pieces;
  });
}

/** Word-synced line split into letters, each tagged with its segment so it can sweep on its own. */
function SweptText({ line, lang }: { line: LyricLine; lang?: string }) {
  const segmentStarts: number[] = [];
  let length = 0;
  for (const segment of line.segments) {
    segmentStarts.push(length);
    length += segment.text.length;
  }
  const segmentAt = (offset: number) => {
    let index = 0;
    while (index + 1 < segmentStarts.length && segmentStarts[index + 1] <= offset) index++;
    return index;
  };
  const letterCounts = line.segments.map(() => 0);
  let offset = 0;
  const words = wordPieces(line.text, lang).map((piece) => {
    const start = offset;
    offset += piece.length;
    if (/^\s+$/.test(piece)) return { space: true as const, text: piece };
    let letterOffset = start;
    return {
      space: false as const,
      letters: graphemes(piece, lang).map((text) => {
        const segment = segmentAt(letterOffset);
        letterOffset += text.length;
        return { text, segment, index: letterCounts[segment]++ };
      }),
    };
  });
  return (
    <>
      {words.map((word, wordIndex) =>
        word.space ? (
          word.text
        ) : (
          <span className="lyricWord" key={wordIndex}>
            {word.letters.map((letter, letterIndex) => (
              <span
                key={letterIndex}
                className="lyricChar"
                data-segment={letter.segment}
                data-index={letter.index}
                data-count={letterCounts[letter.segment]}
              >
                {letter.text}
              </span>
            ))}
          </span>
        ),
      )}
    </>
  );
}

function LyricsArtwork({ track }: { track: Track }) {
  const fallback = thumbnailArtwork(track);
  const [cover, setCover] = useState(
    () => cachedBigscreenArtwork(track) ?? fallback,
  );
  useEffect(() => {
    let cancelled = false;
    setCover(cachedBigscreenArtwork(track) ?? fallback);
    void preloadBigscreenArtwork(track).then((source) => {
      if (!cancelled && source) setCover(source);
    });
    return () => {
      cancelled = true;
    };
  }, [
    track.globalId,
    track.albumId,
    track.cover,
    track.fullCover,
    track.nativeCover,
    track.provider,
    track.upc,
    fallback,
  ]);
  return (
    <img
      id="lyricsArtwork"
      className="lyricsArtwork"
      src={cover}
      alt=""
      onError={() => setCover(cover === fallback ? whiteArtwork : fallback)}
    />
  );
}

function LyricGroups({
  lyrics,
  blocks,
  onSeek,
}: {
  lyrics: TrackLyrics;
  blocks: Block[];
  onSeek?: (seconds: number) => void;
}) {
  const singerIds = lyrics.singers.map((singer) => singer.id);
  for (const block of blocks) {
    if (block.kind !== "lines") continue;
    for (const row of block.rows) {
    if (row.line.singer && !singerIds.includes(row.line.singer))
      singerIds.push(row.line.singer);
    for (const segment of row.line.segments) {
      if (segment.singer && !singerIds.includes(segment.singer))
        singerIds.push(segment.singer);
    }
    }
  }
  // Label a voice only where it changes, not on every line it sings.
  let leadVoices = "";
  return (
    <div className="lyricsLines">
      {blocks.map((block) =>
        block.kind === "pause" ? (
          <div className="lyricGroup lyricPauseGroup" data-block={block.id} key={block.id}>
            <div className="lyricPause" aria-hidden="true">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="lyricPauseDot"
                  style={{ "--dot": dot } as CSSProperties}
                />
              ))}
            </div>
          </div>
        ) : (
        <div className="lyricGroup" data-block={block.id} key={block.id}>
          {block.rows.map(({ id, line, kind, language }) => {
            const singerIndex = line.singer
              ? singerIds.indexOf(line.singer)
              : 0;
            const voices = [
              ...new Set(
                [
                  line.singer,
                  ...line.segments.map((segment) => segment.singer),
                ].filter((id): id is string => id !== null),
              ),
            ];
            const voiceKey = voices.join("\n");
            let showVoices = false;
            if (kind === "lead") {
              showVoices = voiceKey !== leadVoices;
              leadVoices = voiceKey;
            } else if (kind === "background") {
              showVoices = voiceKey !== leadVoices;
            }
            const voiceName = (id: string) =>
              lyrics.singers.find((singer) => singer.id === id)?.name ??
              `Voice ${singerIds.indexOf(id) + 1}`;
            const seekable =
              onSeek &&
              line.startMs !== null &&
              (kind === "lead" || kind === "background");
            const Line = seekable ? "button" : "p";
            return (
              <div
                key={id}
                className={`lyricRow lyricRow-${kind}`}
                data-singer-side={
                  singerIndex % 2 === 1 ? "alternate" : "primary"
                }
              >
                {singerIds.length > 1 &&
                  showVoices &&
                  voices.length > 0 && (
                    <span className="lyricSinger">
                      {voices.map(voiceName).join(" / ")}
                    </span>
                  )}
                <Line
                  className="lyricLine"
                  data-row={id}
                  data-detail={detailedLine(line)}
                  dir="auto"
                  lang={language ?? undefined}
                  type={seekable ? "button" : undefined}
                  onClick={
                    seekable
                      ? () =>
                          onSeek(
                            Math.max(
                              0,
                              (line.startMs! - lyrics.offsetMs) / 1000,
                            ),
                          )
                      : undefined
                  }
                >
                  {detailedLine(line) ? (
                    <SweptText line={line} lang={language ?? lyrics.language ?? undefined} />
                  ) : (
                    line.segments.map((segment, segmentIndex) => (
                      <span
                        key={segmentIndex}
                        className="lyricSegment"
                        title={
                          segment.singer && voices.length > 1
                            ? voiceName(segment.singer)
                            : undefined
                        }
                      >
                        {segment.text}
                      </span>
                    ))
                  )}
                  {!line.text && "\u00a0"}
                </Line>
              </div>
            );
          })}
        </div>
        ),
      )}
    </div>
  );
}

function SyncedLyrics({
  lyrics,
  clock,
  playing,
  reducedMotion,
  onSeek,
}: {
  lyrics: TrackLyrics;
  clock: PlaybackClock;
  playing: boolean;
  reducedMotion: boolean;
  onSeek?: (seconds: number) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => lyricBlocks(lyrics, true), [lyrics]);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const wake = useRef<() => void>(() => {});
  const resume = useRef<() => void>(() => {});

  useEffect(() => {
    wake.current();
  }, [playing]);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const layout = blocks.map((block) => {
      const rows =
        block.kind === "lines"
          ? block.rows.map((row) => {
              const element = container.querySelector<HTMLElement>(
                `[data-row="${row.id}"]`,
              )!;
              return {
                ...row,
                element,
                detailed: detailedLine(row.line),
                letters: Array.from(
                  element.querySelectorAll<HTMLElement>(".lyricChar"),
                  (letter) => ({
                    element: letter,
                    motion: letterMotion(
                      row.line.segments[Number(letter.dataset.segment)],
                      Number(letter.dataset.index),
                      Number(letter.dataset.count),
                    ),
                    head: "",
                  }),
                ),
                active: false,
                animating: false,
                snap: true,
              };
            })
          : [];
      return {
        block,
        element: container.querySelector<HTMLElement>(
          `[data-block="${block.id}"]`,
        )!,
        rows,
        startMs:
          block.kind === "pause" ? block.startMs : lyrics.lines[block.line].startMs,
        top: 0,
        height: 0,
        active: false,
        ending: false,
        progress: "",
        blur: "",
      };
    });
    const rows = layout.flatMap((block) => block.rows);
    const lineBlocks = new Map(
      layout.flatMap(({ block }, index) =>
        block.kind === "lines" ? [[block.line, index] as const] : [],
      ),
    );
    // Skip style writes that would not change anything.
    const setStyle = <Key extends string>(
      element: HTMLElement,
      cache: Record<Key, string>,
      key: Key,
      property: string,
      value: string,
    ) => {
      if (cache[key] === value) return;
      cache[key] = value;
      element.style.setProperty(property, value);
    };
    let frame = 0;
    let lastTime = Number.NaN;
    let focus = -1;
    let target = container.scrollTop;
    let velocity = 0;
    let lastFrame = 0;
    let layoutDirty = true;
    let align = true;
    // Window resizes jump straight to the new position instead of springing through every intermediate size.
    let snapScroll = false;
    const schedule = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(paint);
    };
    const paint = (now: number) => {
      frame = 0;
      if (document.hidden) return;
      const elapsed = lastFrame
        ? Math.min((now - lastFrame) / 1000, 0.032)
        : 1 / 60;
      lastFrame = now;
      const time = clock.getSmooth() * 1000 + lyrics.offsetMs;
      const discontinuity =
        !Number.isFinite(lastTime) ||
        time < lastTime - 50 ||
        time - lastTime > 350;
      for (const block of layout) {
        if (block.block.kind !== "pause") continue;
        const { startMs, endMs } = block.block;
        const active = time >= startMs && time < endMs;
        const ending = active && endMs - time < 600;
        if (active !== block.active || discontinuity) {
          block.element.dataset.active = String(active);
          layoutDirty = true;
        }
        if (ending !== block.ending || discontinuity) {
          block.element.dataset.ending = String(ending);
          layoutDirty = true;
        }
        block.ending = ending;
        if (active)
          setStyle(
            block.element,
            block,
            "progress",
            "--pause-progress",
            Math.min(1, (time - startMs) / Math.max(1, endMs - startMs - 600)).toFixed(3),
          );
      }
      const measured = layoutDirty;
      if (layoutDirty) {
        container.style.setProperty(
          "--lyrics-viewport-height",
          `${container.clientHeight}px`,
        );
        for (const block of layout) {
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
            for (const letter of row.letters) {
              const head = Math.min(2, Math.max(-1, letterHead(letter.motion, time)));
              setStyle(letter.element, letter, "head", "--lyric-head", `${(head * 100).toFixed(1)}%`);
            }
            row.animating = true;
            if (discontinuity) row.snap = true;
          }
          row.active = active;
        }
        let next = layout.findIndex(
          ({ block }) =>
            block.kind === "pause" && time >= block.startMs && time < block.endMs,
        );
        if (next < 0) {
          const line = focusLyric(lyrics.lines, time);
          next = line >= 0 ? (lineBlocks.get(line) ?? -1) : -1;
        }
        if (next < 0) {
          // Hold the last block through short gaps; frame the first one before playback reaches it.
          next = layout.reduce(
            (previous, block, index) =>
              block.startMs !== null && block.startMs <= time ? index : previous,
            -1,
          );
          if (next < 0) next = layout.findIndex((block) => block.startMs !== null);
        }
        for (const [index, block] of layout.entries()) {
          const active =
            block.block.kind === "pause"
              ? block.element.dataset.active === "true"
              : block.rows.some((row) => row.active);
          if (next !== focus || active !== block.active || discontinuity) {
            const distance = Math.abs(index - next);
            block.element.style.setProperty(
              "--lyric-opacity",
              String(
                active || index === next
                  ? 1
                  : index < next
                    ? 0.28
                    : Math.max(0.24, 0.72 - distance * 0.13),
              ),
            );
            // Few fixed steps: a line change only re-filters the handful of groups crossing a step.
            setStyle(
              block.element,
              block,
              "blur",
              "--lyric-blur",
              `${active || index === next ? 0 : blurSteps[Math.min(distance, blurSteps.length - 1)]}px`,
            );
          }
          block.active = active;
        }
        if (next !== focus || measured) align = true;
        focus = next;
        lastTime = time;
      }
      if (followingRef.current && focus >= 0 && align) {
        const block = layout[focus];
        target = Math.max(
          0,
          Math.min(
            container.scrollHeight - container.clientHeight,
            block.top -
              container.clientHeight * 0.43 +
              Math.min(block.height, container.clientHeight * 0.4) / 2,
          ),
        );
        align = false;
      }
      // Letters keep easing after their line ends or playback pauses, so this runs every frame.
      let settling = false;
      for (const row of rows) {
        if (!row.animating) continue;
        let rowMoving = false;
        for (const letter of row.letters) {
          if (reducedMotion) restLetter(letter.motion, letter.element);
          else
            rowMoving =
              animateLetter(letter.motion, letter.element, time, row.active, elapsed, row.snap) ||
              rowMoving;
        }
        row.snap = false;
        const animating = rowMoving || (row.active && !reducedMotion);
        // Letters only get their own compositor layers while they move.
        if (animating !== row.animating) row.element.dataset.animating = String(animating);
        row.animating = animating;
        settling ||= rowMoving;
      }
      let moving = false;
      if (followingRef.current) {
        if (reducedMotion || discontinuity || snapScroll) {
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
      for (const [index, block] of layout.entries()) {
        const lag =
          followingRef.current && !reducedMotion && moving
            ? Math.max(
                -80,
                Math.min(
                  80,
                  (target - container.scrollTop) *
                    Math.min(0.32, Math.abs(index - focus) * 0.065),
                ),
              )
            : 0;
        // Whole device pixels keep blurred layers from resampling at subpixel offsets.
        const snapped = Math.round(lag * devicePixelRatio) / devicePixelRatio;
        const transform = snapped ? `translate3d(0, ${snapped}px, 0)` : "";
        if (block.element.style.transform !== transform)
          block.element.style.transform = transform;
      }
      snapScroll = false;
      if (playingRef.current || moving || settling) schedule();
    };
    const hold = () => {
      followingRef.current = false;
      setFollowing(false);
      velocity = 0;
      schedule();
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(
          event.key,
        ) ||
        (event.key === " " && event.target === container)
      )
        hold();
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
    const resize = new ResizeObserver((entries) => {
      layoutDirty = true;
      if (entries.some((entry) => entry.target === container)) snapScroll = true;
      schedule();
    });
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
  }, [lyrics, blocks, clock, reducedMotion]);

  return (
    <>
      <div
        className="lyricsViewport"
        ref={viewport}
        tabIndex={0}
        data-following={following}
        aria-label="Synced lyrics"
        lang={lyrics.language ?? undefined}
      >
        <LyricGroups
          lyrics={lyrics}
          blocks={blocks}
          onSeek={
            onSeek
              ? (seconds) => {
                  resume.current();
                  onSeek(seconds);
                }
              : undefined
          }
        />
      </div>
      {!following && (
        <button
          className="lyricsResume"
          type="button"
          onClick={() => resume.current()}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 4 8 6-8 6Z" />
          </svg>
          Back to current line
        </button>
      )}
    </>
  );
}

const sources = {
  amll: "AMLL TTML DB",
  "lrc.red": "lrc.red",
  lrclib: "LRCLIB",
};

export function LyricsView({
  track,
  clock,
  playing,
  onSeek,
  motion = "system",
}: LyricsViewProps) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(
    () => track ? cachedLyrics(track) ?? null : null,
  );
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const reducedMotion =
    motion === "reduced" || (motion === "system" && systemReducedMotion);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLyrics(track ? cachedLyrics(track) ?? null : null);
    setError(false);
    if (track) {
      void loadLyrics(track)
        .then((result) => {
          if (!controller.signal.aborted) setLyrics(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        });
    }
    return () => controller.abort();
  }, [
    track?.globalId,
    track?.name,
    track?.artist,
    track?.album,
    track?.durationSeconds,
    track?.isrc,
    track?.version,
    track?.provider,
    track?.providerTrackId,
    attempt,
  ]);

  const unavailableDuringFailure =
    lyrics?.status === "unavailable" && lyrics.failedProviders.length > 0;
  return (
    <main
      id="lyricsPage"
      aria-label="Lyrics"
      data-reduced-motion={reducedMotion}
    >
      <header className="lyricsHeading">
        {track && <LyricsArtwork track={track} />}
      </header>
      <section className="lyricsStage" aria-label="Song lyrics">
        {!track ? (
          <p className="lyricsMessage" role="status">
            Play a song to see its lyrics.
          </p>
        ) : error || unavailableDuringFailure ? (
          <div className="lyricsMessage" role="alert">
            <p>Could not load lyrics. Try again.</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : !lyrics ? (
          <p className="lyricsMessage" role="status">
            Loading lyrics…
          </p>
        ) : lyrics.status === "instrumental" ? (
          <p className="lyricsMessage" role="status">
            Instrumental — this song has no lyrics.
          </p>
        ) : lyrics.status === "unavailable" ? (
          <p className="lyricsMessage" role="status">
            No lyrics available for this song.
          </p>
        ) : lyrics.sync !== "none" ? (
          <SyncedLyrics
            lyrics={lyrics}
            clock={clock}
            playing={playing}
            reducedMotion={reducedMotion}
            onSeek={onSeek}
          />
        ) : (
          <div
            className="lyricsViewport lyricsPlain"
            tabIndex={0}
            aria-label="Unsynced lyrics"
            lang={lyrics.language ?? undefined}
          >
            <p className="lyricsSyncNote">Timing unavailable</p>
            <LyricGroups lyrics={lyrics} blocks={lyricBlocks(lyrics, false)} />
          </div>
        )}
        <footer className="lyricsFooter">
          {lyrics?.status === "lyrics" && (
            <div className="lyricsAttribution">
              <span className="lyricsSyncLabel">
                {lyrics.sync === "none"
                  ? "Unsynced lyrics"
                  : lyrics.hasWordSync
                    ? "Word by word"
                    : "Synced lyrics"}
              </span>
              {lyrics.source && (
                <span className="lyricsCredit">
                  Lyrics from {sources[lyrics.source]}
                </span>
              )}
            </div>
          )}
        </footer>
      </section>
    </main>
  );
}
