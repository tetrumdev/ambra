import { Image } from "expo-image";
import type { Track } from "./client";

const placeholder = require("../assets/ambra.png");

export function Artwork({
  track,
  size = 48,
}: {
  track: Track | null | undefined;
  size?: number;
}) {
  return (
    <Image
      source={track?.cover || placeholder}
      recyclingKey={track?.globalId ?? "empty"}
      contentFit={track?.cover ? "cover" : "contain"}
      transition={120}
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
