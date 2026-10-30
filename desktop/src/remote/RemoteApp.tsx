import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { serverUrl } from "../api/serverConnection";
import { FluidGradientBackground } from "../components/FluidGradientBackground";
import { PlayerControls } from "../components/PlayerControls";
import {
  sampleCoverEdges,
  separateCollapsedPalette,
  separatePaletteFromCover,
  type CoverEdgeSamples,
} from "../utils/backgroundPalette";
import { SURFACE_BLACK } from "../utils/surfaceBlack";
import type { Track } from "../types/music";
import {
  Unpaired,
  awaitPairing,
  command,
  currentTrack,
  follow,
  pairedToken,
  remoteView,
  remoteViewAge,
  requestPairing,
  subscribe,
  type PairingStarted,
} from "./client";

const COVER_ID = "remoteCover";
const blackPalette = { colors: [SURFACE_BLACK, SURFACE_BLACK, SURFACE_BLACK, SURFACE_BLACK], weights: [1, 0, 0, 0] };

function artworkQuery(track: Track) {
  const url = track.nativeCover;
  if (track.provider === "local" || !url?.startsWith("https://")) return null;
  return new URLSearchParams({ provider: track.provider, url }).toString();
}

/** The bigscreen's swirl, colored from the cover. */
function Swirl({ track, playing }: { track: Track | null; playing: boolean }) {
  const [palette, setPalette] = useState(blackPalette);
  const [edges, setEdges] = useState<CoverEdgeSamples | null>(null);
  const query = track ? artworkQuery(track) : null;
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    void Promise.all([
      fetch(serverUrl(`/api/artwork/palette?${query}&weighted=true`))
        .then(response => response.ok ? response.json() as Promise<{ colors: string[]; weights: number[] }> : null)
        .catch(() => null),
      sampleCoverEdges(serverUrl(`/api/artwork/thumbnail?${query}`)),
    ]).then(([next, edges]) => {
      if (cancelled || next?.colors.length !== 4) return;
      setPalette({ colors: separateCollapsedPalette(next.colors), weights: next.weights });
      setEdges(edges);
    });
    return () => { cancelled = true; };
  }, [query]);
  const colors = useMemo(() => separatePaletteFromCover(palette.colors, edges), [edges, palette]);
  return (
    <div className="remoteSwirl" aria-hidden="true">
      <FluidGradientBackground
        colors={colors}
        weights={palette.weights}
        active
        animate={!!track}
        playing={playing}
      />
    </div>
  );
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

function Progress({ position, duration, onSeek, disabled }: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
  disabled: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const at = (event: PointerEvent) => {
    const rect = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration;
  };
  const shown = Math.min(duration, dragging ?? position);
  const fraction = duration > 0 ? shown / duration : 0;
  return (
    <div className="remoteProgress" data-dragging={dragging !== null}>
      <div
        ref={bar}
        className="remoteProgressHit"
        onPointerDown={event => {
          if (disabled || duration <= 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(at(event));
        }}
        onPointerMove={event => { if (dragging !== null) setDragging(at(event)); }}
        onPointerUp={event => {
          if (dragging === null) return;
          setDragging(null);
          onSeek(at(event));
        }}
        onPointerCancel={() => setDragging(null)}
      >
        <div className="remoteProgressTrack">
          <div className="remoteProgressFill" style={{ transform: `scaleX(${fraction})` }} />
        </div>
      </div>
      <div className="remoteTimes">
        <span>{clock(shown)}</span>
        <span>-{clock(duration - shown)}</span>
      </div>
    </div>
  );
}

/** Where the song is now: the last report carried forward while playing. */
function usePosition(playing: boolean, reported: number, duration: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick(value => value + 1), 250);
    return () => clearInterval(timer);
  }, [playing]);
  return Math.min(duration, reported + (playing ? remoteViewAge() : 0));
}

function Player() {
  const view = useSyncExternalStore(subscribe, remoteView);
  const track = currentTrack(view);
  // Shown at once; the server's answer settles it.
  const [wantPlaying, setWantPlaying] = useState<boolean | null>(null);
  const [activations, setActivations] = useState({ previous: 0, next: 0 });
  const playing = wantPlaying ?? view?.playing ?? false;
  const duration = view?.duration || track?.durationSeconds || 0;
  const position = usePosition(!!view?.playing && !view.buffering, view?.positionSeconds ?? 0, duration);
  const disabled = !track || !view?.output;
  useEffect(() => setWantPlaying(null), [view?.playing, view?.revision]);

  const send = (action: string, details?: Record<string, unknown>) => {
    void command(action, details).catch(() => setWantPlaying(null));
  };

  return (
    <>
      <Swirl track={track} playing={playing} />
      <main className="remotePlayer">
        <div id={COVER_ID} className="remoteCover" data-empty={!track}>
          {track
            ? <img key={track.fullCover ?? track.cover} src={track.fullCover ?? track.cover} alt={`${track.album} album cover`} />
            : <img src="/remote/ambra.png" alt="Ambra" />}
        </div>
        <div className="remoteInfo">
          <h1>{track?.name ?? "Nothing playing"}</h1>
          <p>{track?.artist ?? (view && !view.output ? "Choose an output in Ambra" : " ")}</p>
        </div>
        <Progress
          position={position}
          duration={duration}
          disabled={disabled}
          onSeek={seconds => send("seek", { positionSeconds: seconds })}
        />
        <PlayerControls
          isPlaying={playing}
          previousActivation={activations.previous}
          nextActivation={activations.next}
          disabled={disabled}
          onPrevious={() => {
            setActivations(current => ({ ...current, previous: current.previous + 1 }));
            send("previous");
          }}
          onTogglePlayback={() => {
            setWantPlaying(!playing);
            send(playing ? "pause" : "play");
          }}
          onNext={() => {
            setActivations(current => ({ ...current, next: current.next + 1 }));
            send("next");
          }}
        />
      </main>
    </>
  );
}

function Pairing({ onPaired }: { onPaired: () => void }) {
  const [pairing, setPairing] = useState<PairingStarted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    setPairing(null);
    void requestPairing()
      .then(started => {
        setPairing(started);
        return awaitPairing(started.requestId, abort.signal);
      })
      .then(() => { if (!abort.signal.aborted) onPaired(); })
      .catch((reason: Error) => { if (!abort.signal.aborted) setError(reason.message); });
    return () => abort.abort();
  }, [attempt]);

  return (
    <>
      <Swirl track={null} playing={false} />
      <main className="remotePairing">
        <h1>Pair with Ambra</h1>
        {error ? <>
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
        </> : pairing ? <>
          <p>Approve this code on the computer running the server:</p>
          <div className="remoteCode">{pairing.code}</div>
          <code>ambra-server pair approve {pairing.code}</code>
        </> : <p>Asking the server…</p>}
      </main>
    </>
  );
}

export function RemoteApp() {
  const [paired, setPaired] = useState(() => !!pairedToken());
  useEffect(() => {
    if (!paired) return;
    const abort = new AbortController();
    void follow(abort.signal).catch(error => { if (error instanceof Unpaired) setPaired(false); });
    return () => abort.abort();
  }, [paired]);
  return paired ? <Player /> : <Pairing onPaired={() => setPaired(true)} />;
}
