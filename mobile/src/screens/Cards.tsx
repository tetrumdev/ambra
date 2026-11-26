import { Image } from "expo-image";
import type { ReactElement } from "react";
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { usePageGesture } from "../shell/gestures";
import { colors, fonts, space, textSize } from "../theme";
import { Touchable, anchorOf, type Anchor } from "../Touchable";

const placeholder = require("../../assets/ambra.png");

export type Card = {
  key: string;
  title: string;
  subtitle?: string;
  image: string | null;
  /** Up to four covers, shown as desktop's playlist mosaic when there's no single image. */
  images?: string[];
  round?: boolean;
  onPress(): void;
  onLongPress?(anchor: Anchor): void;
};

/** A cover, or desktop's four-cover mosaic. */
export function CardArt({ image, images, size, round = false }: { image: string | null; images?: string[]; size: number; round?: boolean }) {
  const frame = { width: size, height: size, borderRadius: round ? size / 2 : Math.max(8, size / 14) };
  if (!image && images && images.length >= 4) {
    return <View style={[styles.image, styles.mosaic, frame]}>
      {images.slice(0, 4).map(url => <Image key={url} source={url} contentFit="cover" enforceEarlyResizing cachePolicy="disk" transition={0} style={styles.tile} />)}
    </View>;
  }
  const source = image ?? images?.[0] ?? null;
  return <Image source={source || placeholder} contentFit={source ? "cover" : "contain"} enforceEarlyResizing cachePolicy="disk" transition={0} style={[styles.image, frame]} />;
}

function CardView({ card, width }: { card: Card; width: number }) {
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={[card.title, card.subtitle].filter(Boolean).join(", ")} scale={0.94} haptic="select"
      onPress={card.onPress} onLongPress={card.onLongPress && (event => card.onLongPress!(anchorOf(event)))} style={{ width }}>
      <CardArt image={card.image} images={card.images} size={width} round={card.round} />
      <Text numberOfLines={1} style={[styles.title, card.round && styles.centered]}>{card.title}</Text>
      {card.subtitle && <Text numberOfLines={1} style={[styles.subtitle, card.round && styles.centered]}>{card.subtitle}</Text>}
    </Touchable>
  );
}

const CARD = 144;
const GAP = 14;

/**
 * A titled, sideways-scrolling row, as desktop's home sections. It snaps card by card, and a
 * swipe on it moves the row, not the tab.
 */
export function CardRow({ title, cards, empty, size = CARD }: { title: string; cards: Card[]; empty?: string; size?: number }) {
  const page = usePageGesture();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
      {cards.length ? <ScrollView horizontal block={page ?? undefined} showsHorizontalScrollIndicator={false} decelerationRate="fast" snapToInterval={size + GAP} snapToAlignment="start" contentContainerStyle={styles.row}>
        {cards.map(card => <CardView key={card.key} card={card} width={size} />)}
      </ScrollView> : empty ? <Text style={styles.empty}>{empty}</Text> : null}
    </View>
  );
}

/** Two columns of cards, for library artists and albums. */
export function CardGrid({ cards, header, bottomInset, onScroll }: { cards: Card[]; header?: ReactElement; bottomInset: number; onScroll?: React.ComponentProps<typeof FlatList>["onScroll"] }) {
  const { width } = useWindowDimensions();
  const size = (width - 20 * 2 - 16) / 2;
  return (
    <FlatList
      data={cards}
      keyExtractor={card => card.key}
      numColumns={2}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: bottomInset + 24 }}
      scrollIndicatorInsets={{ bottom: bottomInset }}
      initialNumToRender={10}
      maxToRenderPerBatch={8}
      windowSize={5}
      onScroll={onScroll}
      scrollEventThrottle={16}
      ListHeaderComponent={header}
      renderItem={({ item }) => <CardView card={item} width={size} />}
    />
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: 22 },
  heading: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.heading, fontWeight: "600", paddingHorizontal: 20, paddingBottom: 12 },
  row: { gap: GAP, paddingHorizontal: 20 },
  gridRow: { gap: space.lg, marginBottom: 20 },
  image: { backgroundColor: colors.raised, borderCurve: "continuous", overflow: "hidden" },
  mosaic: { flexDirection: "row", flexWrap: "wrap" },
  tile: { width: "50%", height: "50%" },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.small, fontWeight: "500", marginTop: 8 },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.caption, marginTop: 3 },
  centered: { textAlign: "center" },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.small, lineHeight: 20, paddingHorizontal: 20 },
});
