import { requireOptionalNativeModule } from "expo-modules-core";
const native = requireOptionalNativeModule<{
  call(operation: string, args: string): Promise<string>;
  online?(): boolean;
  addListener?(event: "onPathChange", listener: (event: { online: boolean }) => void): { remove(): void };
}>("AmbraNetwork");
export const nativeNetworkAvailable = Boolean(native);
export async function networkCall<T>(operation: string, args: unknown = {}): Promise<T> {
  if (!native) throw new Error("Native networking requires an Ambra development build. Expo Go is unsupported.");
  const result = JSON.parse(await native.call(operation, JSON.stringify(args))) as { ok?: T; error?: string };
  if (result.error) throw new Error(result.error);
  return result.ok as T;
}

/** False when the phone has no network at all; true when it does or can't tell. */
export const deviceOnline = () => native?.online?.() ?? true;
/** Hears the phone gaining or losing every network path. */
export function subscribeDevicePath(listener: () => void) {
  const subscription = native?.addListener?.("onPathChange", () => listener());
  return () => subscription?.remove();
}
