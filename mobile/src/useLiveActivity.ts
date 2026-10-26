import { isRunningInExpoGo, requireOptionalNativeModule } from "expo";
import { useEffect } from "react";
import { Platform } from "react-native";

export function useLiveActivity(paired: boolean) {
  useEffect(() => {
    if (!paired || Platform.OS !== "ios" || isRunningInExpoGo() || !requireOptionalNativeModule("ExpoWidgets")) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("./liveActivity.ios").then(module => {
      if (!disposed) stop = module.followLiveActivity();
    }).catch(error => console.warn("Live Activities are unavailable in this build:", error));
    return () => { disposed = true; stop?.(); };
  }, [paired]);
}
