import { requireOptionalNativeModule } from "expo-modules-core";

/** The downloads Live Activity (Dynamic Island, Lock Screen); absent in Expo Go and on Android. */
const native = requireOptionalNativeModule<{
  show(done: number, total: number, title: string | null): Promise<void>;
  finish(total: number): Promise<void>;
}>("AmbraActivity");

export const showDownloadActivity = (done: number, total: number, title: string | null) => native?.show(done, total, title).catch(() => {});
export const finishDownloadActivity = (total: number) => native?.finish(total).catch(() => {});

/** The system volume (0 to 1), which the phone's buttons also set; absent in Expo Go and on Android. */
const volume = requireOptionalNativeModule<{
  get(): number;
  set(volume: number): Promise<void>;
  addListener(event: "onChange", listener: (event: { volume: number }) => void): { remove(): void };
}>("AmbraVolume");
export const systemVolume = volume ? () => volume.get() : undefined;
export const setSystemVolume = volume ? (level: number) => { void volume.set(level).catch(() => {}); } : undefined;
/** Hears the system volume (0 to 1) as it moves, by the buttons or otherwise; a no-op where there's none. */
export function subscribeSystemVolume(listener: (volume: number) => void) {
  const subscription = volume?.addListener("onChange", event => listener(event.volume));
  return () => subscription?.remove();
}
