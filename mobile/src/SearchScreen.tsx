import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchSession, SearchSnapshot } from "../../desktop/src/utils/searchSession";
import { musicProviderName } from "../../desktop/src/utils/musicProviderName";
import { openSearch } from "./catalog";
import { changeQueue, command, currentTrack, type QueueItem } from "./client";
import { TrackRow } from "./TrackBrowser";
import { playEntries } from "./queueModel";
import { catalogSearch, type CatalogPage } from "./library";
import { useNavigation } from "./navigation";
import { useTrackMenus } from "./TrackMenus";
import { CardRow } from "./screens/Cards";
import { albumCard, artistCard } from "./screens/Pages";
import { searchText, textRelevance } from "../../desktop/src/utils/catalogRanking";
import { servicePreferences, services, subscribeServicePreferences, type Service } from "./servicePreferences";
import { Icon } from "./Icons";
import { Touchable } from "./Touchable";
import { colors, fonts } from "./theme";

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

export function SearchScreen() {
  const { view, bottomInset, push } = useNavigation();
  const insets = useSafeAreaInsets();
  const selected = useSyncExternalStore(subscribeServicePreferences, servicePreferences);
  const [query, setQuery] = useState("");
  const [filter, setProvider] = useState<"all" | Service>("all");
  const provider = filter !== "all" && !selected[filter] ? "all" : filter;
  const [response, setResponse] = useState({ key: "", snapshot: empty });
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{ key: string; value: ReturnType<typeof mergeCatalog> } | null>(null);
  const { openPlayback, openEdit, menus } = useTrackMenus();
  const session = useRef<SearchSession | null>(null);
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
  const run = useCallback((work: () => Promise<void>) => {
    if (!view?.output) { setError("Choose an audio output in the player first."); return; }
    setError(null);
    void work().catch(reason => setError(reason instanceof Error ? reason.message : "Couldn't update playback."));
  }, [view?.output]);
  const play = useCallback((index: number) => {
    run(() => currentTrack(view)?.globalId === results[index]?.globalId ? command(view?.playing ? "pause" : "play") : changeQueue(queue => playEntries(queue, entries.slice(index), results), true));
  }, [run, view, entries, results]);
  const hold = useCallback((index: number) => openPlayback(index, entries, results), [openPlayback, entries, results]);
  const more = useCallback((index: number) => openEdit(results[index]), [openEdit, results]);
  const now = currentTrack(view);
  const found = catalog?.key === searchKey && query.trim() ? catalog.value : null;
  return <View style={styles.screen}>
    <View style={{ paddingTop: insets.top + 24, paddingHorizontal: 24 }}>
      <Text accessibilityRole="header" style={styles.title}>Search</Text>
      <Text style={styles.subtitle}>One search. All your music services.</Text>
      <View style={styles.searchBox}>
        <Icon name="search" size={18} color={colors.muted} />
        <TextInput accessibilityLabel="Search Ambra" value={query} onChangeText={setQuery} placeholder="Songs, artists, albums…" placeholderTextColor={colors.faint} autoCorrect={false} autoCapitalize="none" returnKeyType="search" keyboardAppearance="dark" clearButtonMode="while-editing" style={styles.input} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {(["all", ...services.filter(service => selected[service])] as const).map(value => <Touchable key={value} accessibilityRole="button" accessibilityLabel={value === "all" ? "Search all music services" : `Search ${musicProviderName(value)}`} accessibilityState={{ selected: provider === value }} onPress={() => setProvider(value)} style={[styles.filter, provider === value && styles.selected]}>
          <Text style={[styles.filterText, provider === value && styles.selectedText]}>{value === "all" ? "AMBRA" : musicProviderName(value)}</Text>
        </Touchable>)}
      </ScrollView>
    </View>
    <FlatList data={results} keyExtractor={track => track.globalId} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: bottomInset + 24 }} scrollIndicatorInsets={{ bottom: bottomInset }} extraData={`${now?.globalId}:${view?.playing}`} initialNumToRender={12} maxToRenderPerBatch={8}
      renderItem={({ item, index }) => <View><TrackRow track={item} index={index} active={now?.globalId === item.globalId} playing={!!view?.playing} onPress={play} onHold={hold} onMore={more} /><Text style={styles.provider}>{musicProviderName(item.provider)}</Text></View>}
      onEndReached={() => { if (snapshot.hasMore && !snapshot.isSearching) void session.current?.loadMore(); }} onEndReachedThreshold={0.5}
      ListHeaderComponent={<View>
        {error || snapshot.error ? <View style={styles.notice}><Text accessibilityRole="alert" style={styles.error}>{error ?? snapshot.error}</Text>{snapshot.canRetry && <Touchable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.retry}><Text style={styles.retryText}>Retry search</Text></Touchable>}</View> : null}
        {!!found?.artists.length && <View style={styles.catalog}><CardRow title="Artists" cards={found.artists.map(artist => artistCard(artist, push))} /></View>}
        {!!found?.albums.length && <View style={styles.catalog}><CardRow title="Albums" cards={found.albums.map(album => albumCard(album, push))} /></View>}
        {results.length > 0 && <Text style={styles.songsHeading}>Songs</Text>}
      </View>}
      ListEmptyComponent={!snapshot.isSearching && !snapshot.error ? <Text style={styles.empty}>{query.trim() ? "No matching songs. Try another title or artist." : "Search connected services together. Matching recordings merge automatically, with desktop’s relevance and quality ranking."}</Text> : undefined}
      ListFooterComponent={snapshot.isSearching ? <ActivityIndicator accessibilityLabel="Searching music services" color={colors.muted} style={styles.loading} /> : undefined} />
    {menus}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  title: { color: "white", fontFamily: fonts.serif, fontSize: 38 },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, marginTop: 8, marginBottom: 24 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, borderRadius: 12, borderColor: "#2f2f2f", borderWidth: 1, backgroundColor: "#151515", paddingHorizontal: 14 },
  input: { flex: 1, color: "white", fontFamily: fonts.sans, fontSize: 16, minHeight: 48 },
  filters: { gap: 8, paddingVertical: 16 },
  filter: { borderRadius: 8, minHeight: 40, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#191919" },
  selected: { backgroundColor: "#e6d3b1" },
  filterText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  selectedText: { color: "#241b0e", fontWeight: "600" },
  provider: { color: colors.faint, fontFamily: fonts.sans, fontSize: 10, marginLeft: 70, marginTop: -9, marginBottom: 6 },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 23, padding: 24, textAlign: "center" },
  loading: { margin: 24 },
  notice: { padding: 12 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 14, lineHeight: 21 },
  retry: { minHeight: 44, justifyContent: "center" },
  retryText: { color: "white", fontFamily: fonts.sans, fontSize: 14 },
  catalog: { marginHorizontal: -12 },
  songsHeading: { color: "white", fontFamily: fonts.sans, fontSize: 20, fontWeight: "600", paddingHorizontal: 12, paddingTop: 20, paddingBottom: 8 },
});
