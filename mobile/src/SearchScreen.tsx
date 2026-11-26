import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
import { ActivityIndicator, Animated, FlatList, StyleSheet, Text, TextInput, View, useAnimatedValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchSession, SearchSnapshot } from "../../desktop/src/utils/searchSession";
import { musicProviderName } from "../../desktop/src/utils/musicProviderName";
import { openSearch } from "./catalog";
import type { Track } from "../../desktop/src/types/music";
import { changeQueue, command, currentTrack, sessionView, type QueueItem } from "./client";
import { TrackRow } from "./TrackRow";
import { playEntries } from "./queueModel";
import { catalogSearch, type CatalogPage } from "./library";
import { useNavigation, useNowPlaying, useRun } from "./navigation";
import { useTrackMenus } from "./TrackMenus";
import { CardRow } from "./screens/Cards";
import { albumCard, artistCard } from "./screens/Pages";
import { searchText, textRelevance } from "../../desktop/src/utils/catalogRanking";
import { servicePreferences, services, subscribeServicePreferences, type Service } from "./servicePreferences";
import { Segmented } from "./shell/Segmented";
import { Icon } from "./Icons";
import { Touchable, type Frame } from "./Touchable";
import { ReorderRow } from "./reorder";
import { colors, fonts, haptic, radius, space, textSize } from "./theme";

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<Track>);
const empty: SearchSnapshot = { results: [], allResults: [], artists: [], albums: [], candidates: [], isSearching: false, hasMore: false, error: null, canRetry: false };

/** Merges each service's catalog answer, best name matches first and one card per name. */
function mergeCatalog(query: string, pages: CatalogPage[]) {
  const unique = <T,>(items: T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()];
  const artists = unique(pages.flatMap(page => page.artists), artist => searchText(artist.name))
    .sort((a, b) => textRelevance(b.name, query) - textRelevance(a.name, query)).slice(0, 12);
  const albums = unique(pages.flatMap(page => page.albums), album => `${searchText(album.title)}:${searchText(album.artist)}`)
    .sort((a, b) => textRelevance(b.title, query) - textRelevance(a.title, query)).slice(0, 16);
  return { artists, albums };
}

/**
 * One search across every service. The field sits at the top and stays there; the title above
 * it slides away as results scroll. Songs swipe and hold like everywhere else.
 */
export function SearchScreen() {
  const { bottomInset, push } = useNavigation();
  const { trackId: nowId, playing } = useNowPlaying();
  const insets = useSafeAreaInsets();
  const run = useRun();
  const selected = useSyncExternalStore(subscribeServicePreferences, servicePreferences);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setProvider] = useState<"all" | Service>("all");
  const provider = filter !== "all" && !selected[filter] ? "all" : filter;
  const [response, setResponse] = useState({ key: "", snapshot: empty });
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<{ key: string; value: ReturnType<typeof mergeCatalog> } | null>(null);
  const { openSong, enqueue } = useTrackMenus();
  const session = useRef<SearchSession | null>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const scroll = useAnimatedValue(0);
  const focus = useAnimatedValue(0);
  useEffect(() => { Animated.spring(focus, { toValue: focused ? 1 : 0, damping: 22, stiffness: 260, mass: 0.7, useNativeDriver: true }).start(); }, [focused, focus]);
  const searchKey = JSON.stringify([query.trim(), selected, provider, attempt]);
  const snapshot = response.key === searchKey ? response.snapshot : query.trim() ? { ...empty, isSearching: true } : empty;
  useEffect(() => {
    const abort = new AbortController();
    session.current = null;
    const trimmed = query.trim();
    const timer = setTimeout(() => {
      if (!trimmed) return;
      void openSearch(trimmed, selected, provider, abort.signal, next => {
        if (!abort.signal.aborted) setResponse({ key: searchKey, snapshot: next });
      }).then(next => { if (!abort.signal.aborted) session.current = next; }).catch(reason => {
        if (!abort.signal.aborted) setResponse({ key: searchKey, snapshot: { ...empty, error: reason instanceof Error ? reason.message : "Search failed. Try again.", canRetry: true } });
      });
    }, 300);
    // Artists and albums, as desktop's catalog search finds them, alongside the songs.
    const catalogTimer = setTimeout(() => {
      if (!trimmed) return;
      const providers = services.filter(service => selected[service] && (provider === "all" || provider === service));
      void Promise.allSettled(providers.map(service => catalogSearch(trimmed, service, abort.signal))).then(results => {
        if (abort.signal.aborted) return;
        const pages = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
        setCatalog({ key: searchKey, value: mergeCatalog(trimmed, pages) });
      });
    }, 350);
    return () => { clearTimeout(timer); clearTimeout(catalogTimer); abort.abort(); };
  }, [query, selected, provider, searchKey]);
  const results = snapshot.results;
  const entries = useMemo<QueueItem[]>(() => results.map((track, index) => ({ globalTrackId: track.globalId, source: { kind: "search", id: query.trim(), entryId: index + 1 } })), [results, query]);
  const latest = useRef({ entries, results });
  useLayoutEffect(() => { latest.current = { entries, results }; });
  const play = useCallback((index: number) => {
    const { entries, results } = latest.current;
    const view = sessionView();
    run(() => currentTrack(view)?.globalId === results[index]?.globalId ? command(view?.playing ? "pause" : "play") : changeQueue(queue => playEntries(queue, entries.slice(index), results), true));
  }, [run]);
  const menu = useCallback((index: number, frame: Frame) => {
    const { entries, results } = latest.current;
    const view = sessionView();
    const track = results[index];
    if (!track) return;
    openSong(index, entries, results, frame, <TrackRow track={track} index={index} active={currentTrack(view)?.globalId === track.globalId} playing={!!view?.playing} detail={musicProviderName(track.provider)} onPress={() => {}} />);
  }, [openSong]);
  const found = catalog?.key === searchKey && query.trim() ? catalog.value : null;
  const titleHeight = 58;
  return <View style={styles.screen}>
    <AnimatedFlatList data={results} keyExtractor={track => track.globalId} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      scrollEventThrottle={16} onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], { useNativeDriver: true })}
      contentContainerStyle={{ paddingTop: insets.top + titleHeight + 132, paddingHorizontal: 12, paddingBottom: bottomInset + 24 }}
      scrollIndicatorInsets={{ top: insets.top + titleHeight + 120, bottom: bottomInset }} extraData={`${nowId}:${playing}`} initialNumToRender={12} maxToRenderPerBatch={8}
      renderItem={({ item, index }) => <ReorderRow index={index} onHold={menu}><TrackRow track={item} index={index} active={nowId === item.globalId} playing={playing} detail={musicProviderName(item.provider)}
        onPress={play} onMenu={menu}
        swipeStart={{ icon: "playNext", label: "Play Next", run: () => enqueue(index, latest.current.entries, latest.current.results, true) }}
        swipeEnd={{ icon: "addToQueue", label: "Queue", run: () => enqueue(index, latest.current.entries, latest.current.results, false) }} /></ReorderRow>}
      onEndReached={() => { if (snapshot.hasMore && !snapshot.isSearching) void session.current?.loadMore(); }} onEndReachedThreshold={0.5}
      ListHeaderComponent={<View>
        {snapshot.error ? <View style={styles.notice}><Text accessibilityRole="alert" style={styles.error}>{snapshot.error}</Text>{snapshot.canRetry && <Touchable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.retry}><Text style={styles.retryText}>Retry search</Text></Touchable>}</View> : null}
        {!!found?.artists.length && <View style={styles.bleed}><CardRow title="Artists" size={112} cards={found.artists.map(artist => artistCard(artist, push))} /></View>}
        {!!found?.albums.length && <View style={styles.bleed}><CardRow title="Albums" cards={found.albums.map(album => albumCard(album, push))} /></View>}
        {results.length > 0 && <Text style={styles.songsHeading}>Songs</Text>}
      </View>}
      ListEmptyComponent={!snapshot.isSearching && !snapshot.error ? <Text style={styles.empty}>{query.trim() ? "No results" : ""}</Text> : undefined}
      ListFooterComponent={snapshot.isSearching ? <ActivityIndicator accessibilityLabel="Searching music services" color={colors.muted} style={styles.loading} /> : undefined} />
    {/* The header floats over the results; scrolling slides the title up behind the field. */}
    <Animated.View style={[styles.header, { paddingTop: insets.top + 24, transform: [{ translateY: scroll.interpolate({ inputRange: [0, titleHeight], outputRange: [0, -titleHeight], extrapolate: "clamp" }) }] }]}>
      <Animated.Text accessibilityRole="header" style={[styles.title, { opacity: scroll.interpolate({ inputRange: [0, titleHeight * 0.7], outputRange: [1, 0], extrapolate: "clamp" }) }]}>Search</Animated.Text>
      <Animated.View style={[styles.searchBox, { transform: [{ scale: focus.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }) }] }]}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.searchRing, { opacity: focus }]} />
        <Icon name="search" size={18} color={focused ? colors.text : colors.muted} />
        <TextInput ref={input} onFocus={() => { haptic.tick(); setFocused(true); }} onBlur={() => setFocused(false)} accessibilityLabel="Search Ambra" value={query} onChangeText={setQuery}
          placeholder="Songs, artists, albums" placeholderTextColor={colors.faint} selectionColor={colors.accent} keyboardAppearance="dark"
          autoCorrect={false} autoCapitalize="none" returnKeyType="search" style={styles.input} />
        {query.length > 0 && <Touchable accessibilityRole="button" accessibilityLabel="Clear search" haptic="tick" scale={0.8} onPress={() => { setQuery(""); input.current?.focus(); }} style={styles.clear}>
          <Icon name="close" size={12} color={colors.black} />
        </Touchable>}
      </Animated.View>
      <View style={styles.filters}>
        <Segmented<"all" | Service> label="Search in" value={provider} onChange={setProvider}
          items={[{ value: "all" as const, label: "AMBRA" }, ...services.filter(service => selected[service]).map(service => ({ value: service, label: musicProviderName(service) }))]} />
      </View>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  header: { position: "absolute", left: 0, right: 0, top: 0, backgroundColor: colors.black, paddingBottom: 8 },
  title: { color: colors.text, fontFamily: fonts.serif, fontSize: textSize.page, height: 58, paddingHorizontal: 20 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: space.md, marginHorizontal: 20, paddingHorizontal: 14, minHeight: 48, borderRadius: radius.pill, backgroundColor: colors.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  searchRing: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.accent },
  input: { flex: 1, paddingVertical: 10, color: colors.text, fontFamily: fonts.sans, fontSize: textSize.body },
  clear: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.muted },
  filters: { marginTop: 12, marginHorizontal: 0 },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 23, padding: 24, textAlign: "center" },
  loading: { margin: 24 },
  notice: { padding: 12 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: textSize.small, lineHeight: 21 },
  retry: { minHeight: 44, justifyContent: "center" },
  retryText: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.small },
  bleed: { marginHorizontal: -12 },
  songsHeading: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.heading, fontWeight: "600", paddingHorizontal: 8, paddingTop: 20, paddingBottom: 8 },
});
