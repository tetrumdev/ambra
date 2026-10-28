import { invoke, isTauri } from "@tauri-apps/api/core";
import { cancelServiceAuth, completeServiceAuth, startServiceAuth, type StreamingProvider } from "../api/server";
import { serverConnectionSignal } from "../api/serverConnection";

/** Keep one browser attempt bound to the server selected when sign-in started. */
export async function signInService(provider: StreamingProvider, signal: AbortSignal, onManualCallback?: (submit: ((url: string) => Promise<void>) | null) => void): Promise<void> {
  if (!isTauri()) throw new Error("Sign in to services from the Ambra desktop app.");
  const connection = serverConnectionSignal();
  const operation = AbortSignal.any([signal, connection]);
  operation.throwIfAborted();
  const result = await startServiceAuth(provider, operation);
  operation.throwIfAborted();
  if (result.status === "connected") return;
  if (!result.loginUrl || !result.attemptId) throw new Error("Update the Ambra server to use automatic sign-in.");
  const attemptId = result.attemptId;
  const cancel = () => {
    void invoke("cancel_service_login", { attemptId }).catch(() => {});
  };
  operation.addEventListener("abort", cancel, { once: true });
  try {
    operation.throwIfAborted();
    const browser = invoke<string>("open_service_login", { provider, loginUrl: result.loginUrl, attemptId });
    if (provider === "tidal") onManualCallback?.(url => invoke("submit_service_login", { attemptId, callbackUrl: url }));
    const callbackUrl = await browser;
    operation.throwIfAborted();
    if (new URL(callbackUrl).searchParams.has("error")) throw new Error("Service sign-in was declined.");
    await completeServiceAuth(provider, callbackUrl, attemptId, operation);
    operation.throwIfAborted();
  } catch (error) {
    cancel();
    // Never send a late callback or cancellation to a newly selected server.
    if (!connection.aborted) await cancelServiceAuth(provider, attemptId, connection).catch(() => {});
    throw error;
  } finally {
    onManualCallback?.(null);
    operation.removeEventListener("abort", cancel);
  }
}
