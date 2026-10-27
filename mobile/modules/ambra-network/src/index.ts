import { requireOptionalNativeModule } from "expo-modules-core";
const native = requireOptionalNativeModule<{ call(operation: string, args: string): Promise<string> }>("AmbraNetwork");
export const nativeNetworkAvailable = Boolean(native);
export async function networkCall<T>(operation: string, args: unknown = {}): Promise<T> {
  if (!native) throw new Error("Native networking requires an Ambra development build. Expo Go is unsupported.");
  const result = JSON.parse(await native.call(operation, JSON.stringify(args))) as { ok?: T; error?: string };
  if (result.error) throw new Error(result.error);
  return result.ok as T;
}
