import { Image } from "expo-image";
import { FlatList, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { colors, fonts } from "../theme";
import { Touchable } from "../Touchable";

const placeholder = require("../../assets/ambra.png");

export type Card = { key: string; title: string; subtitle?: string; image: string | null; round?: boolean; onPress(): void; onLongPress?(): void };

function CardView({ card, width }: { card: Card; width: number }) {
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={[card.title, card.subtitle].filter(Boolean).join(", ")} scale={0.96} haptic="select" onPress={card.onPress} onLongPress={card.onLongPress} style={{ width }}>
      <Image source={card.image || placeholder} contentFit={card.image ? "cover" : "contain"} enforceEarlyResizing cachePolicy="disk" transition={0}
        style={[styles.image, { width, height: width, borderRadius: card.round ? width / 2 : 10 }]} />
      <Text numberOfLines={1} style={[styles.title, card.round && styles.centered]}>{card.title}</Text>
      {card.subtitle && <Text numberOfLines={1} style={[styles.subtitle, card.round && styles.centered]}>{card.subtitle}</Text>}
    </Touchable>
  );
}

/** A titled, sideways-scrolling row, as desktop's home sections. */
export function CardRow({ title, cards, empty }: { title: string; cards: Card[]; empty?: string }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
      {cards.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {cards.map(card => <CardView key={card.key} card={card} width={136} />)}
      </ScrollView> : empty ? <Text style={styles.empty}>{empty}</Text> : null}
    </View>
  );
}

/** Two columns of cards, for library artists and albums. */
export function CardGrid({ cards, header, bottomInset }: { cards: Card[]; header?: React.ReactElement; bottomInset: number }) {
  const { width } = useWindowDimensions();
  const size = (width - 24 * 2 - 16) / 2;
  return (
    <FlatList
      data={cards}
      keyExtractor={card => card.key}
      numColumns={2}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: bottomInset + 24 }}
      scrollIndicatorInsets={{ bottom: bottomInset }}
      initialNumToRender={10}
      maxToRenderPerBatch={8}
      windowSize={5}
      ListHeaderComponent={header}
      renderItem={({ item }) => <CardView card={item} width={size} />}
    />
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: 20 },
  heading: { color: "white", fontFamily: fonts.sans, fontSize: 20, fontWeight: "600", paddingHorizontal: 24, paddingBottom: 12 },
  row: { gap: 14, paddingHorizontal: 24 },
  gridRow: { gap: 16, marginBottom: 20 },
  image: { backgroundColor: "#141414", borderCurve: "continuous" },
  title: { color: "white", fontFamily: fonts.sans, fontSize: 14, fontWeight: "500", marginTop: 8 },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, marginTop: 3 },
  centered: { textAlign: "center" },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, paddingHorizontal: 24 },
});
