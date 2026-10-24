import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { LyricAnnotation, LyricLine, TrackLyrics } from "../types/lyrics";
import { needsLyricsRetry } from "../types/lyrics";
import type { Track } from "../types/music";
import type { PlaybackClock } from "../utils/playbackClock";
import type { LyricMotion } from "../utils/preferences";
import { cachedLyrics, loadLyrics } from "../utils/lyricsCache";
import { recordSyncSample } from "../utils/lyricsAutoTuning";
import { detectLyricOffset, firstAutoSyncNotice, lyricAutoSyncKey, storedLyricEvidence, storedLyricOffset } from "../utils/lyricsOffset";
import { subscribeRemoteChanges } from "../utils/serverState";
import {
  lyricSyncKey,
  lyricSyncOverride,
  MAX_CORRECTION_MS,
  saveLyricSyncOverride,
  type LyricSyncOverride,
} from "../utils/lyricsSyncOverrides";
import {
  detailedLine,
  focusLyric,
  lyricActive,
  sweepSegments,
} from "../utils/lyricsTiming";
import {
  advanceSpring,
  animateDot,
  animateLetter,
  DOT_EXIT_MS,
  dotMotion,
  letterHead,
  letterMotion,
  releasing,
  restLetter,
  RIPPLE_MAX_LINES,
  RIPPLE_STAGGER_MS,
  rippleSpring,
} from "../utils/lyricsMotion";
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";
import { lyricDisplayLine } from "../utils/lyricTypography";
import "./LyricsView.css";
import "./TrackMenus.css";

type LyricsViewProps = {
  track: Track | undefined;
  clock: PlaybackClock;
  playing: boolean;
  onSeek?: (seconds: number) => void;
  motion?: LyricMotion;
  autoSync?: boolean;
  /** Added to every song's timing, for a delay in the output itself (Settings → Lyrics offset). */
  globalOffsetMs?: number;
  /** False while the view fades out behind the cover; the lyrics hold still meanwhile. */
  shown?: boolean;
  /** Hidden because the song's vocals are over, or returning on its own as the next song starts, so the fade drifts slowly. */
  resting?: boolean;
  /** The previous song's lyrics, drifting away as the next song's arrive. */
  leaving?: boolean;
  /** This song's lyrics are replacing another's on screen. */
  arriving?: boolean;
};

type Row = {
  id: string;
  line: LyricLine;
  kind: "lead" | "background" | "romanization";
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
      line.romanization.forEach((annotation, index) =>
        rows.push({
          id: `${prefix}-romanization-${index}`,
          line: annotationLine(annotation, line),
          kind: "romanization",
          language: annotation.language,
        }),
      );
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
    if (!token || /^\s+$/.test(token)) return token ? [token] : [];
    if (!IntlSegmenter || !unspacedScript.test(token))
      // Hyphens and dashes stay with the part before them and may end a line, as in plain text.
      return token.match(/[^-‐‑–—/]*[-‐‑–—/]+|[^-‐‑–—/]+/g) ?? [token];
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


function LyricGroups({
  lyrics,
  blocks,
  onSeek,
  credits,
}: {
  lyrics: TrackLyrics;
  blocks: Block[];
  onSeek?: (seconds: number) => void;
  credits?: ReactNode;
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
                <span key={dot} className="lyricPauseDot" />
              ))}
            </div>
          </div>
        ) : (
        <div className="lyricGroup" data-block={block.id} key={block.id}>
          {block.rows.map(({ id, line: sourceLine, kind, language }) => {
            const line = lyricDisplayLine(sourceLine);
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
      {credits}
    </div>
  );
}

const sources = {
  amll: "AMLL TTML DB",
  "lrc.red": "lrc.red",
  lrclib: "LRCLIB",
};

/** Shown after the last line, where the song ends. */
function LyricsCredits({ lyrics }: { lyrics: TrackLyrics }) {
  return (
    <div className="lyricsCredits">
      <span className="lyricsSyncLabel">
        {lyrics.sync === "none"
          ? "Unsynced lyrics"
          : lyrics.hasWordSync
            ? "Word-by-word lyrics"
            : "Synced lyrics"}
      </span>
      {lyrics.source && (
        <span className="lyricsCredit">Lyrics from {sources[lyrics.source]}</span>
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
  menu,
  frozen = false,
}: {
  lyrics: TrackLyrics;
  clock: PlaybackClock;
  playing: boolean;
  frozen?: boolean;
  reducedMotion: boolean;
  onSeek?: (seconds: number) => void;
  menu: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => lyricBlocks(lyrics, true), [lyrics]);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  // While fading out, the next song's clock must not scroll or restart these lyrics.
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
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
    const linesElement = container.querySelector<HTMLElement>(".lyricsLines")!;
    const credits = {
      element: linesElement.querySelector<HTMLElement>(".lyricsCredits"),
      transform: "",
    };
    const layout = blocks.map((block) => {
      const rows =
        block.kind === "lines"
          ? block.rows.map((row) => {
              const element = container.querySelector<HTMLElement>(
                `[data-row="${row.id}"]`,
              )!;
              const segments = sweepSegments(row.line);
              return {
                ...row,
                element,
                detailed: detailedLine(row.line),
                letters: Array.from(
                  element.querySelectorAll<HTMLElement>(".lyricChar"),
                  (letter) => ({
                    element: letter,
                    motion: letterMotion(
                      segments[Number(letter.dataset.segment)],
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
      const dots = Array.from(
        container.querySelectorAll<HTMLElement>(`[data-block="${block.id}"] .lyricPauseDot`),
        (element) => ({ element, motion: dotMotion() }),
      );
      return {
        block,
        element: container.querySelector<HTMLElement>(
          `[data-block="${block.id}"]`,
        )!,
        rows,
        dots,
        dotsAnimating: false,
        dotsSnap: true,
        startMs:
          block.kind === "pause" ? block.startMs : lyrics.lines[block.line].startMs,
        top: 0,
        moved: 0,
        anchor: 0,
        /** Where each later visual line of a wrapped lead line starts being sung, and how far below the first it sits. */
        wraps: [] as { startMs: number; offset: number }[],
        // The scroll position this block is drawn at; it trails the real scroll during a ripple.
        ripple: { value: container.scrollTop, velocity: 0 },
        goal: container.scrollTop,
        pending: container.scrollTop,
        releaseAt: 0,
        transform: "",
        active: false,
        ending: false,
        opacity: "",
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
    /** How far the focused block's sung visual line sits below its first. */
    let wrapOffset = 0;
    let target = container.scrollTop;
    // The scroll the WebView last applied while following, kept to avoid reading it back every frame.
    const scroll = { value: container.scrollTop };
    const viewportStyle = { height: "" };
    let maximumScroll = 0;
    let viewportWidth = container.clientWidth;
    let viewportHeight = container.clientHeight;
    let lastFrame = 0;
    let wasPlaying = playingRef.current;
    let layoutDirty = true;
    let align = true;
    // Window resizes jump straight to the new position instead of springing through every intermediate size.
    let snapScroll = false;
    // Block the last ripple was centred on; the next wave sets off from there.
    let rippleFocus = -1;
    /** Sends each block towards the new scroll target a beat after its neighbour nearer the wave's start. */
    const ripple = (next: number, now: number) => {
      const direction = Math.sign(next - target);
      const origin =
        rippleFocus < 0
          ? focus
          : direction > 0
            ? Math.min(rippleFocus, focus)
            : Math.max(rippleFocus, focus);
      rippleFocus = focus;
      for (const [index, block] of layout.entries()) {
        const rank = Math.min(
          RIPPLE_MAX_LINES,
          Math.max(0, direction > 0 ? index - origin : origin - index),
        );
        const releaseAt = now + rank * RIPPLE_STAGGER_MS;
        // A block still waiting on the last wave leaves on time rather than being held back again.
        block.releaseAt =
          block.pending !== block.goal ? Math.min(block.releaseAt, releaseAt) : releaseAt;
        block.pending = next;
      }
    };
    const schedule = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(paint);
    };
    const paint = (now: number) => {
      frame = 0;
      if (document.hidden) return;
      const frameSeconds = lastFrame ? Math.max(0, (now - lastFrame) / 1000) : 1 / 60;
      const elapsed = Math.min(frameSeconds, 0.1);
      lastFrame = now;
      const sampledTime = frozenRef.current && Number.isFinite(lastTime)
        ? lastTime
        : clock.getSmooth() * 1000 + lyrics.offsetMs;
      const expectedAdvance = wasPlaying && playingRef.current ? frameSeconds * 1000 : 0;
      wasPlaying = playingRef.current;
      const discontinuity =
        !Number.isFinite(lastTime) ||
        sampledTime < lastTime - 50 ||
        sampledTime - lastTime > Math.max(350, expectedAdvance + 150);
      // Small native-clock corrections must not switch focus back across a line boundary.
      const time = discontinuity ? sampledTime : Math.max(lastTime, sampledTime);
      for (const block of layout) {
        if (block.block.kind !== "pause") continue;
        const { startMs, endMs } = block.block;
        const active = time >= startMs && time < endMs;
        // The slot opens with the break and closes only once the dots have faded out.
        const ending = active && endMs - time < DOT_EXIT_MS;
        if (active !== block.active || discontinuity) {
          block.element.dataset.active = String(active);
          layoutDirty = true;
        }
        if (ending !== block.ending || discontinuity) {
          block.element.dataset.ending = String(ending);
          layoutDirty = true;
        }
        block.ending = ending;
        if (active || discontinuity) block.dotsAnimating = true;
        if (discontinuity) block.dotsSnap = true;
      }
      const measured = layoutDirty;
      if (layoutDirty) {
        const previousAnchor = layout[focus]?.anchor;
        setStyle(
          container,
          viewportStyle,
          "height",
          "--lyrics-viewport-height",
          `${container.clientHeight}px`,
        );
        for (const block of layout) {
          const previousTop = block.top;
          block.top = block.element.offsetTop;
          block.moved = block.top - previousTop;
          const lead = block.rows[0];
          const line = lead?.element;
          if (line) {
            // Anchor the first visual line, not the centre of a wrapped group or its annotations.
            const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
            block.anchor = block.top +
              line.getBoundingClientRect().top - block.element.getBoundingClientRect().top +
              lineHeight / 2;
            // A word-timed line that wraps is followed one visual line at a time as it is sung.
            block.wraps = [];
            if (lead.detailed && line.offsetHeight > lineHeight * 1.5) {
              const firstTop = lead.letters[0]?.element.offsetTop ?? 0;
              let lastTop = firstTop;
              for (const letter of lead.letters) {
                const top = letter.element.offsetTop;
                const startMs = letter.motion.segment.startMs;
                if (top <= lastTop + lineHeight / 2 || startMs === null) continue;
                lastTop = top;
                block.wraps.push({ startMs, offset: top - firstTop });
              }
            }
          } else {
            // The dots keep the same anchor while their surrounding slot expands or collapses.
            block.anchor = block.top + block.element.querySelector<HTMLElement>(".lyricPause")!.offsetHeight / 2;
          }
        }
        maximumScroll = Math.max(0, linesElement.offsetTop + linesElement.offsetHeight - container.clientHeight);
        if (previousAnchor !== undefined && followingRef.current && !discontinuity && !snapScroll) {
          // Reflow above the active line must not move it on screen or restart its wave.
          // Shifting where every block is drawn is enough; the realignment below moves the real scroll.
          const shift = layout[focus].anchor - previousAnchor;
          target = Math.max(0, Math.min(maximumScroll, target + shift));
          for (const block of layout) {
            // Every block is drawn where it was before the reflow and glides to its new place,
            // so a break opening or closing eases the lines apart instead of jumping them.
            block.ripple.value += block.moved;
            block.goal += shift;
            block.pending += shift;
          }
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
            setStyle(
              block.element,
              block,
              "opacity",
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
        const wrap = next >= 0
          ? layout[next].wraps.reduce((offset, step) => (time >= step.startMs ? step.offset : offset), 0)
          : 0;
        if (next !== focus || measured || wrap !== wrapOffset) align = true;
        focus = next;
        wrapOffset = wrap;
        lastTime = time;
      }
      if (followingRef.current && focus >= 0 && align) {
        const block = layout[focus];
        // Land on a whole device pixel so lines come to rest crisp, with no leftover transform.
        const pixel = window.devicePixelRatio || 1;
        let next = Math.round(
          Math.max(
            0,
            Math.min(
              maximumScroll,
              block.anchor + wrapOffset - container.clientHeight * 0.43,
            ),
          ) * pixel,
        ) / pixel;
        if (next !== scroll.value) {
          // The real scroll jumps once per line; block transforms below hide the jump in the same frame,
          // so the wave itself is compositor-only and never scrolls the page frame by frame.
          container.scrollTop = next;
          next = scroll.value = container.scrollTop;
        }
        if (next !== target) ripple(next, now);
        target = next;
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
        // Letters stay in their line's layer: promoting and dropping a layer per letter at every
        // line change cost more than repainting one line.
        row.animating =
          rowMoving ||
          (!reducedMotion &&
            (row.active || row.letters.some((letter) => releasing(letter.motion, time))));
        settling ||= rowMoving;
      }
      for (const block of layout) {
        if (block.block.kind !== "pause" || !block.dotsAnimating) continue;
        const { startMs, endMs } = block.block;
        let dotsMoving = false;
        for (const [index, dot] of block.dots.entries())
          dotsMoving =
            animateDot(
              dot.motion,
              dot.element,
              index,
              block.dots.length,
              time,
              startMs,
              endMs,
              elapsed,
              block.dotsSnap || reducedMotion,
              !reducedMotion,
            ) || dotsMoving;
        block.dotsSnap = false;
        block.dotsAnimating = dotsMoving || block.active;
        settling ||= dotsMoving;
      }
      const snapRipple = !followingRef.current || reducedMotion || discontinuity || snapScroll;
      if (snapRipple) rippleFocus = focus;
      for (const block of layout) {
        const spring = block.ripple;
        if (snapRipple) {
          // While browsing the page scrolls natively and every block sits where it is laid out.
          spring.value = block.goal = block.pending = scroll.value;
          spring.velocity = 0;
        } else {
          if (block.pending !== block.goal && now >= block.releaseAt) block.goal = block.pending;
          if (spring.value !== block.goal || spring.velocity)
            settling = advanceSpring(spring, block.goal, rippleSpring, elapsed) || settling;
          settling ||= block.pending !== block.goal;
        }
        // Subpixel offsets let the wave settle without stepping between device pixels.
        const offset = followingRef.current ? scroll.value - spring.value : 0;
        const transform = Math.abs(offset) > 0.01 ? `translate3d(0, ${offset.toFixed(3)}px, 0)` : "";
        if (block.transform !== transform) {
          block.transform = transform;
          block.element.style.transform = transform;
        }
      }
      // The credits sit right under the last line and ride its wave, rather than jumping with the real scroll.
      const lastTransform = layout[layout.length - 1]?.transform ?? "";
      if (credits.element && credits.transform !== lastTransform) {
        credits.transform = lastTransform;
        credits.element.style.transform = lastTransform;
      }
      snapScroll = false;
      if (playingRef.current || settling) schedule();
    };
    const hold = () => {
      followingRef.current = false;
      setFollowing(false);
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
      // Clicking a line seeks to it; only tabbing through lines means the reader is browsing.
      if (event.target instanceof HTMLButtonElement && event.target.matches(":focus-visible")) hold();
    };
    resume.current = () => {
      followingRef.current = true;
      setFollowing(true);
      scroll.value = container.scrollTop;
      // Ripple back from where the reader left off.
      target = scroll.value;
      for (const block of layout) {
        block.ripple.value = block.goal = block.pending = scroll.value;
        block.ripple.velocity = 0;
      }
      align = true;
      schedule();
    };
    wake.current = schedule;
    const resize = new ResizeObserver(() => {
      layoutDirty = true;
      if (container.clientWidth !== viewportWidth || container.clientHeight !== viewportHeight) {
        viewportWidth = container.clientWidth;
        viewportHeight = container.clientHeight;
        snapScroll = true;
      }
      schedule();
    });
    resize.observe(container);
    resize.observe(linesElement);
    for (const block of layout) resize.observe(block.element);
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
          credits={<LyricsCredits lyrics={lyrics} />}
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
      <LyricsControls onResume={following ? undefined : () => resume.current()}>
        {menu}
      </LyricsControls>
    </>
  );
}

/** One pill: "Back to current line" while browsing, joined by the sync menu on hover. */
function LyricsControls({
  onResume,
  children,
}: {
  onResume?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="lyricsControls" data-resume={Boolean(onResume)}>
      {onResume && (
        <button className="lyricsResume" type="button" onClick={onResume}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 4 8 6-8 6Z" />
          </svg>
          Back to current line
        </button>
      )}
      {children}
    </div>
  );
}

function formatCorrection(correctionMs: number) {
  if (!correctionMs) return "Original";
  // A positive correction shows each line earlier.
  return `${(Math.abs(correctionMs) / 1000).toFixed(1)} s ${correctionMs > 0 ? "earlier" : "later"}`;
}

const nudges = [-500, -100, 100, 500];
/** Playing this long with synced lyrics on screen, without retiming them, counts as the timing looking right. */
const WATCHED_MS = 30_000;

function SyncMenu({
  unsynced,
  correctionMs,
  edited,
  analyzing,
  canAnalyze,
  onAutoSync,
  onNudge,
  onReset,
  onToggleSync,
}: {
  unsynced: boolean;
  correctionMs: number;
  edited: boolean;
  analyzing: boolean;
  canAnalyze: boolean;
  onAutoSync: () => void;
  onNudge: (deltaMs: number) => void;
  onReset: () => void;
  onToggleSync: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useFadeOutOnUnmount(panel);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="lyricsSyncMenu" ref={root}>
      <button
        ref={trigger}
        className="lyricsSyncTrigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 3.5a6.5 6.5 0 1 0 6.5 6.5h-1.6A4.9 4.9 0 1 1 10 5.1V7l3-2.75L10 1.5Z" />
        </svg>
        Sync
      </button>
      {open && (
        <div ref={panel} className="lyricsSyncPanel" role="menu" aria-label="Lyric sync">
          {unsynced ? (
            <button className="menuItem" type="button" role="menuitem" onClick={choose(onToggleSync)}>
              Turn sync back on
            </button>
          ) : (
            <>
              <button
                className="menuItem"
                type="button"
                role="menuitem"
                disabled={!canAnalyze || analyzing}
                onClick={choose(onAutoSync)}
              >
                {analyzing ? "Analyzing…" : "Auto-sync now"}
              </button>
              <div className="lyricsSyncTiming" role="group" aria-label="Timing">
                <span className="lyricsSyncTimingLabel">
                  Timing<strong>{formatCorrection(correctionMs)}</strong>
                </span>
                <span className="lyricsSyncNudges">
                  {nudges.map((delta) => (
                    <button
                      key={delta}
                      type="button"
                      role="menuitem"
                      aria-label={`Show lyrics ${Math.abs(delta) / 1000} s ${delta > 0 ? "earlier" : "later"}`}
                      onClick={() => onNudge(delta)}
                    >
                      {delta > 0 ? "+" : "−"}
                      {Math.abs(delta) / 1000}
                    </button>
                  ))}
                </span>
                <span className="lyricsSyncHint">+ shows lines sooner</span>
              </div>
              <button className="menuItem" type="button" role="menuitem" disabled={!edited} onClick={choose(onReset)}>
                Reset timing
              </button>
              <button className="menuItem" type="button" role="menuitem" onClick={choose(onToggleSync)}>
                Turn off sync for this song
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const NOTICE_MS = 4000;

export function LyricsView({
  track,
  clock,
  playing,
  onSeek,
  motion = "system",
  autoSync = false,
  globalOffsetMs = 0,
  shown = true,
  resting = false,
  leaving = false,
  arriving = false,
}: LyricsViewProps) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(
    () => track ? cachedLyrics(track) ?? null : null,
  );
  const [error, setError] = useState(false);
  const [detected, setDetected] = useState<{ lyrics: TrackLyrics; correctionMs: number } | null>(null);
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

  const timed = lyrics?.status === "lyrics" && lyrics.sync !== "none";
  // LyricsView remounts per track, so the saved choice is read once, then followed as other
  // devices change it, so every screen's lyrics move together.
  const [override, setOverride] = useState<LyricSyncOverride | undefined>(
    () => track ? lyricSyncOverride(track.globalId) : undefined,
  );
  const [remoteAnalyses, setRemoteAnalyses] = useState(0);
  useEffect(() => subscribeRemoteChanges(keys => {
    if (track && keys.has(lyricSyncKey)) setOverride(lyricSyncOverride(track.globalId));
    if (keys.has(lyricAutoSyncKey)) setRemoteAnalyses(count => count + 1);
  }), [track?.globalId]);
  const updateOverride = (next: LyricSyncOverride) => {
    if (!track) return;
    setOverride(next);
    saveLyricSyncOverride(track.globalId, next);
  };
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null);
  const showNotice = (text: string) => setNotice((current) => ({ text, id: (current?.id ?? 0) + 1 }));
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const autoSyncedNotice = (correctionMs: number) =>
    `Lyrics auto-synced · ${formatCorrection(correctionMs)}`;

  const manual = override?.correctionMs !== undefined;
  useEffect(() => {
    if (!autoSync || manual || !isTauri() || !track || !lyrics || !timed) return;
    let cancelled = false;
    void detectLyricOffset(track, lyrics)
      .then((result) => {
        if (cancelled) return;
        const correctionMs = result.confident ? result.correctionMs : 0;
        setDetected({ lyrics, correctionMs });
        if (correctionMs && firstAutoSyncNotice(track.globalId, correctionMs)) showNotice(autoSyncedNotice(correctionMs));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [autoSync, manual, track, lyrics, timed]);

  const [analyzing, setAnalyzing] = useState(false);
  const forceAutoSync = () => {
    if (!track || !lyrics) return;
    setAnalyzing(true);
    void detectLyricOffset(track, lyrics)
      .then((result) => {
        // Asked for explicitly, the best match is applied even when it is too weak to apply on its
        // own; the listener can see whether it fits and nudge it, which also tunes auto-sync.
        const correctionMs = result.confident ? result.correctionMs : result.bestMs;
        if (correctionMs === null) {
          showNotice("Too few timed lines to auto-sync this song");
          return;
        }
        // An explicit request is the listener's choice, so it is kept like a manual edit.
        updateOverride({ ...override, correctionMs });
        if (!result.confident) showNotice(`Best guess · ${formatCorrection(correctionMs)}`);
        else showNotice(correctionMs ? autoSyncedNotice(correctionMs) : "Lyrics are already in sync");
      })
      .catch(() => showNotice("Couldn't analyze this song"))
      .finally(() => setAnalyzing(false));
  };

  // A song analyzed ahead of playback opens in sync instead of jumping once the result arrives.
  const storedCorrectionMs = useMemo(
    () => autoSync && !manual && isTauri() && track && lyrics && timed
      ? storedLyricOffset(track, lyrics)
      : undefined,
    [autoSync, manual, track, lyrics, timed, remoteAnalyses],
  );
  const correctionMs = manual
    ? override!.correctionMs!
    : autoSync && detected?.lyrics === lyrics ? detected.correctionMs : storedCorrectionMs ?? 0;
  const unsynced = timed && override?.unsynced === true;
  const syncedLyrics = useMemo(
    () => lyrics && (correctionMs || globalOffsetMs)
      ? { ...lyrics, offsetMs: lyrics.offsetMs + correctionMs + globalOffsetMs }
      : lyrics,
    [lyrics, correctionMs, globalOffsetMs],
  );
  // Where the listener leaves each song's timing tunes how readily auto-sync trusts itself.
  const recordSample = (finalMs: number, edited: boolean) => {
    if (!track || !lyrics || !timed) return;
    const evidence = storedLyricEvidence(track, lyrics);
    if (evidence) recordSyncSample(track.globalId, { ...evidence, finalMs, edited });
  };
  const watching = playing && timed && !unsynced && autoSync;
  const watch = useRef({ ms: 0, since: 0 });
  const latest = useRef({ recordSample, correctionMs });
  latest.current = { recordSample, correctionMs };
  useEffect(() => {
    if (!watching) return;
    watch.current.since = performance.now();
    return () => {
      watch.current.ms += performance.now() - watch.current.since;
    };
  }, [watching]);
  // Declared after the watch effect, so its time is counted before this runs on unmount.
  useEffect(
    () => () => {
      if (watch.current.ms >= WATCHED_MS) latest.current.recordSample(latest.current.correctionMs, false);
    },
    [],
  );
  const plainLyrics = useMemo(
    () => lyrics && unsynced ? { ...lyrics, sync: "none" as const, hasWordSync: false } : lyrics,
    [lyrics, unsynced],
  );
  const menu = timed && (
    <SyncMenu
      unsynced={unsynced}
      correctionMs={correctionMs}
      edited={manual}
      analyzing={analyzing}
      canAnalyze={isTauri()}
      onAutoSync={forceAutoSync}
      onNudge={(deltaMs) => {
        const next = Math.max(-MAX_CORRECTION_MS, Math.min(MAX_CORRECTION_MS, correctionMs + deltaMs));
        updateOverride({ ...override, correctionMs: next });
        recordSample(next, true);
      }}
      onReset={() => {
        updateOverride({ unsynced: override?.unsynced });
        if (track) recordSyncSample(track.globalId, null);
      }}
      onToggleSync={() => updateOverride({ ...override, unsynced: !unsynced })}
    />
  );

  const unavailableDuringFailure =
    lyrics !== null && needsLyricsRetry(lyrics);
  // Lyrics that had to load rise in over the loading text, as cached ones arrive with the page.
  const loadedLate = useRef(false);
  if (track && !error && !lyrics) loadedLate.current = true;
  return (
    <main
      id="lyricsPage"
      aria-label="Lyrics"
      aria-hidden={!shown}
      data-shown={shown}
      data-resting={resting}
      data-leaving={leaving}
      data-arriving={arriving}
      data-loaded-late={loadedLate.current}
      data-reduced-motion={reducedMotion}
    >
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
        ) : timed && !unsynced ? (
          <SyncedLyrics
            lyrics={syncedLyrics!}
            clock={clock}
            playing={playing && shown}
            frozen={!shown}
            reducedMotion={reducedMotion}
            onSeek={onSeek}
            menu={menu}
          />
        ) : (
          <>
            <div
              className="lyricsViewport lyricsPlain"
              tabIndex={0}
              aria-label="Unsynced lyrics"
              lang={lyrics.language ?? undefined}
            >
              <p className="lyricsSyncNote">
                {unsynced ? "Sync turned off for this song" : "Timing unavailable"}
              </p>
              <LyricGroups
                lyrics={plainLyrics!}
                blocks={lyricBlocks(plainLyrics!, false)}
                credits={<LyricsCredits lyrics={plainLyrics!} />}
              />
            </div>
            {menu && <LyricsControls>{menu}</LyricsControls>}
          </>
        )}
        {notice && (
          <div className="lyricsNotice" role="status" key={notice.id}>
            {notice.text}
          </div>
        )}
      </section>
    </main>
  );
}
