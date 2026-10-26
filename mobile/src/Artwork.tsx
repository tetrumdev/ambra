import { Image } from "expo-image";
import { thumbnailArtwork, type Track } from "./client";

const placeholder = require("../assets/ambra.png");

export function Artwork({
  track,
  size = 48,
}: {
  track: Track | null | undefined;
  size?: number;
}) {
  const source = thumbnailArtwork(track);
  return (
    <Image
      source={source || placeholder}
      recyclingKey={track?.globalId ?? "empty"}
      contentFit={source ? "cover" : "contain"}
      enforceEarlyResizing
      cachePolicy="disk"
      transition={0}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 8),
        borderCurve: "continuous",
        backgroundColor: "#141414",
      }}
    />
  );
}
