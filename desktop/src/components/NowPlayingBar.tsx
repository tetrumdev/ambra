import type {AudioDeckController} from "../hooks/useAudioPlayer";
import type {Track} from "../types/music";
import "./NowPlayingBar.css";
import {AudioDecks} from "./AudioDecks";
import {PlaybackProgress} from "./PlaybackProgress";
import {PlayerControls} from "./PlayerControls";
import {SongInfo} from "./SongInfo";
import {ExtraCtrls} from "./ExtraCtrls.tsx";

type PlayerBarVariant = "expanded" | "compact";

type NowPlayingBarProps = {
    variant: PlayerBarVariant;
    track: Track;
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    audioDecks: AudioDeckController;
    onPrevious: () => void;
    onTogglePlayback: () => void | Promise<void>;
    onNext: () => void;
    onSeek: (time: number) => void;
    onOpenBigscreen?: () => void;
    onOpenQueue?: () => void;
};

export function NowPlayingBar({
                                  variant,
                                  track,
                                  onOpenBigscreen,
                                  currentTime,
                                  duration,
                                  isPlaying,
                                  audioDecks,
                                  onPrevious,
                                  onTogglePlayback,
                                  onNext,
                                  onSeek,
                                  onOpenQueue,
                              }: NowPlayingBarProps) {
    return (
        <div id="bottomInfoBar" data-variant={variant}>
            <AudioDecks controller={audioDecks}/>
            {variant === "compact" && (
                <button
                    id="compactArtwork"
                    type="button"
                    onClick={onOpenBigscreen}
                    aria-label="Open bigscreen player"
                >
                    <img src={track.cover} alt=""/>
                </button>
            )}
            <SongInfo track={track}/>
            <div id="playbackCluster">
                <PlayerControls
                    isPlaying={isPlaying}
                    onPrevious={onPrevious}
                    onTogglePlayback={onTogglePlayback}
                    onNext={onNext}
                />
                <PlaybackProgress
                    currentTime={currentTime}
                    duration={duration}
                    onSeek={onSeek}
                />
            </div>
            <div id="extraControlsCluster">
                <ExtraCtrls
                    onOpenQueue={onOpenQueue}
                />
            </div>
        </div>
    );
}
