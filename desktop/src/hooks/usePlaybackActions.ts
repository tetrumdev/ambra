import { resolveTrackPlayback, type SearchProvider } from "../api/server";
import type { EntityAction } from "../components/EntityView";
import type { GlobalTrackId, QueueContext, Track } from "../types/music";
import { isTrackAvailable } from "./useServiceAvailability";
import type { AudioPlayer } from "./useAudioPlayer";
import { queueEntryForTrack, type QueueController } from "./useQueue";
import type { useTrackSearch } from "./useTrackSearch";
import { searchQueueContext } from "../utils/queueModel";
import { useStableCallback } from "./useStableCallback";

type PlaybackActionsOptions = {
  queue: QueueController;
  player: Pick<AudioPlayer, "playTrack" | "clear">;
  activeCollectionContext: () => QueueContext;
  search: ReturnType<typeof useTrackSearch>;
  searchQuery: string;
  searchProvider: SearchProvider;
  browseContextKey: string;
  rememberTracks: (tracks: Track[]) => void;
};

type QueueAction = "addToQueue" | "playNext";

export function usePlaybackActions({
  queue, player, activeCollectionContext, search, searchQuery, searchProvider, browseContextKey, rememberTracks,
}: PlaybackActionsOptions) {
  const playFromCollection = useStableCallback((trackId: GlobalTrackId) => {
    queue.playFromContext(activeCollectionContext(), trackId);
    player.playTrack(trackId);
  });

  const shuffleCollection = useStableCallback(() => {
    const first = queue.shuffleContext(activeCollectionContext());
    if (first) player.playTrack(first.track.globalId);
  });

  const actOnCollection = (action: QueueAction | "playStandalone", trackId: GlobalTrackId) => {
    const entry = queueEntryForTrack(activeCollectionContext(), trackId);
    if (!entry) return;
    const shouldStart = action === "playStandalone" || queue.currentEntry === undefined;
    queue[action](entry);
    if (shouldStart) player.playTrack(trackId);
  };
  const playStandaloneFromCollection = useStableCallback((id: GlobalTrackId) => actOnCollection("playStandalone", id));
  const addToQueueFromCollection = useStableCallback((id: GlobalTrackId) => actOnCollection("addToQueue", id));
  const playNextFromCollection = useStableCallback((id: GlobalTrackId) => actOnCollection("playNext", id));

  const searchContextKey = `search:${searchProvider}:${searchQuery.trim()}`;
  const resolvedSearchContext = async (trackId: GlobalTrackId) => {
    const track = await search.resolveTrack(trackId);
    return {
      context: searchQueueContext(
        search.results,
        searchContextKey,
        track,
      ),
      track,
    };
  };

  const selectedSearchTrack = (trackId: GlobalTrackId) =>
    search.candidates.find(track => track.globalId === trackId)
      ?? search.knownTracks.find(track => track.globalId === trackId);

  const visibleSearchContext = (trackId: GlobalTrackId) =>
    searchQueueContext(
      search.results,
      searchContextKey,
      selectedSearchTrack(trackId),
    );

  const playStandaloneFromSearch = useStableCallback(async (trackId: GlobalTrackId) => {
    const { context, track } = await resolvedSearchContext(trackId);
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    queue.playStandalone(entry);
    player.playTrack(trackId, track);
  });

  const queueFromSearch = async (action: QueueAction, trackId: GlobalTrackId) => {
    if (queue.currentEntry) {
      const entry = queueEntryForTrack(visibleSearchContext(trackId), trackId);
      if (!entry) return;
      queue[action](entry);
      void search.resolveTrack(trackId);
      return;
    }
    const { context, track } = await resolvedSearchContext(trackId);
    const entry = queueEntryForTrack(context, trackId);
    if (!entry) return;
    queue[action](entry);
    player.playTrack(trackId, track);
  };
  const addToQueueFromSearch = useStableCallback((id: GlobalTrackId) => queueFromSearch("addToQueue", id));
  const playNextFromSearch = useStableCallback((id: GlobalTrackId) => queueFromSearch("playNext", id));

  const onEntityAction = useStableCallback(async (action: EntityAction, tracks: Track[], id?: string) => {
    if (id && !isTrackAvailable(id)) return;
    tracks = tracks.filter(track => isTrackAvailable(track));
    if (!tracks.length) return;
    const selected = tracks.find(track => track.globalId === id) ?? tracks[0];
    try {
      const track = await resolveTrackPlayback(selected, AbortSignal.timeout(8000));
      rememberTracks([track]);
      const context = searchQueueContext(tracks, browseContextKey, track);
      if (action === "shuffle") {
        const first = queue.shuffleContext(context);
        if (first) player.playTrack(first.track.globalId, await resolveTrackPlayback(first.track, AbortSignal.timeout(8000)));
        return;
      }
      if (action === "play") { queue.playFromContext(context, track.globalId); player.playTrack(track.globalId, track); return; }
      const entry = queueEntryForTrack(context, track.globalId);
      if (!entry) return;
      if (action === "standalone") { queue.playStandalone(entry); player.playTrack(track.globalId, track); return; }
      const start = !queue.currentEntry;
      if (action === "next") queue.playNext(entry);
      else if (action === "nextAll") queue.playNextAll(context.entries);
      else for (const item of context.entries) queue.addToQueue(item);
      if (start) player.playTrack(track.globalId, track);
    } catch (error) { console.warn("Could not play catalog tracks:", error); }
  });

  const jumpToQueueEntry = useStableCallback((queueId: number) => {
    const entry = queue.jumpTo(queueId);
    if (entry) player.playTrack(entry.track.globalId);
  });

  const replayQueueHistoryEntry = useStableCallback((historyId: string) => {
    const entry = queue.replayHistory(historyId);
    if (entry) player.playTrack(entry.track.globalId, entry.track);
  });

  const deleteQueueEntries = useStableCallback((queueIds: number[]) => {
    const result = queue.removeEntries(queueIds);
    if (!result.currentRemoved) return;
    if (result.item) player.playTrack(result.item.track.globalId);
    else player.clear();
  });

  return {
    onEntityAction, playFromCollection, shuffleCollection,
    playStandaloneFromCollection, addToQueueFromCollection, playNextFromCollection,
    playStandaloneFromSearch, addToQueueFromSearch, playNextFromSearch, selectedSearchTrack,
    jumpToQueueEntry, replayQueueHistoryEntry, deleteQueueEntries,
  };
}
