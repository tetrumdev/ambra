import { Image } from "expo-image";

// These are the original app assets, shared directly with desktop.
const assets = {
  play: require("../../desktop/public/play.svg"),
  pause: require("../../desktop/public/pause.svg"),
  skip: require("../../desktop/public/skip.svg"),
  shuffle: require("../../desktop/public/shuffle.svg"),
  queue: require("../../desktop/public/queue.svg"),
  lyrics: require("../../desktop/public/lyrics.svg"),
  more: require("../../desktop/public/menu.svg"),
  playNext: require("../../desktop/public/play-next.svg"),
  addToQueue: require("../../desktop/public/add-to-queue.svg"),
  remove: require("../../desktop/public/delete.svg"),
  output: require("../../desktop/public/volume-high.svg"),
  close: require("../../desktop/public/x.svg"),
  check: require("../../desktop/public/check.svg"),
};

export type IconName = keyof typeof assets;

export function Icon({ name, size = 22, color = "white", rotation = 0 }: { name: IconName; size?: number; color?: string; rotation?: number }) {
  return (
    <Image
      source={assets[name]}
      style={{ width: size, height: size, transform: [{ rotate: `${rotation}deg` }] }}
      contentFit="contain"
      tintColor={color}
      transition={0}
      accessible={false}
    />
  );
}
