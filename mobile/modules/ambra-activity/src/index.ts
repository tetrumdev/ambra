import { requireOptionalNativeModule } from "expo-modules-core";

/** The downloads Live Activity (Dynamic Island, Lock Screen); absent in Expo Go and on Android. */
const native = requireOptionalNativeModule<{
  show(done: number, total: number, title: string | null): Promise<void>;
  finish(total: number): Promise<void>;
}>("AmbraActivity");

export const showDownloadActivity = (done: number, total: number, title: string | null) => native?.show(done, total, title).catch(() => {});
export const finishDownloadActivity = (total: number) => native?.finish(total).catch(() => {});
