import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  coreCommand,
  coreOutputs,
  coreSession,
  coreSessions,
  coreView,
  setCoreStages,
  subscribeCore,
  type CoreOutput,
  type CoreSession,
  type CoreStage,
} from "../api/core";
import { serverBaseUrl, serverConnection, serverConnectionSignal } from "../api/serverConnection";
import { invokeOn } from "../utils/playbackTarget";
import type { useAudioSettings } from "./AudioSettingsContext";

/** Every session has a General stage: the outputs picked by hand in the volume menu. */
export const GENERAL_STAGE = "general";

type StagesState = { stages: CoreStage[]; activeId: string };

function fromSession(session: CoreSession | undefined): StagesState | null {
  // A server from before stages has none to offer.
  if (!session?.stages) return null;
  const general = session.stages.some((stage) => stage.id === GENERAL_STAGE)
    ? []
    : [{ id: GENERAL_STAGE, name: "General", outputs: coreOutputs(session) }];
  return {
    stages: [...general, ...session.stages],
    activeId: session.activeStage ?? GENERAL_STAGE,
  };
}

/**
 * The followed session's stages and the one chosen, while `active`; loaded again whenever
 * `reload` changes. `save` changes them from the latest list.
 */
export function useStages(active: boolean, reload?: unknown) {
  const session = useSyncExternalStore(subscribeCore, coreSession);
  const [state, setState] = useState<StagesState | null>(null);
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void coreSessions()
      .then((list) => {
        if (!disposed) setState(fromSession(list.find((other) => other.id === session)));
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [active, session, reload]);

  const save = async (
    change: (stages: CoreStage[], activeId: string) => CoreStage[],
    nextActive?: string,
  ) => {
    const current = latest.current;
    if (!current) return;
    const stages = change(current.stages, current.activeId);
    const activeId = nextActive ?? current.activeId;
    latest.current = { stages, activeId };
    setState(latest.current);
    // General has nothing to keep until it has played somewhere.
    const list = await setCoreStages(
      session,
      stages.filter((stage) => stage.outputs.length > 0),
      activeId,
    );
    const saved = fromSession(list.find((other) => other.id === session));
    if (saved && latest.current.stages === stages) {
      latest.current = saved;
      setState(saved);
    }
  };

  const activeStage = state
    ? (state.stages.find((stage) => stage.id === state.activeId) ??
      state.stages.find((stage) => stage.id === GENERAL_STAGE)!)
    : null;
  return { stages: state?.stages ?? null, activeStage, save };
}

/** The outputs last picked on this device for each session's General stage, by session id. */
const PICKED_KEY = "ambra.general-outputs.v1";

function pickedHere(): Record<string, CoreOutput[]> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PICKED_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, CoreOutput[]>) : {};
  } catch {
    return {};
  }
}

/** Remembers the outputs picked by hand on this device, for `restoreGeneralOutputs`. */
export function rememberGeneralOutputs(sessionId: string, outputs: CoreOutput[]) {
  try {
    localStorage.setItem(PICKED_KEY, JSON.stringify({ ...pickedHere(), [sessionId]: outputs }));
  } catch {
    /* Storage unavailable: connecting falls back to this computer's output. */
  }
}

/**
 * Run on connecting: when General plays only on outputs out of reach (their computer away, or
 * the device unplugged), it moves to the ones last picked on this device that are in reach,
 * else to `fallback`. `localDevices` are this computer's connected outputs, "" included: the
 * server may not list this computer yet.
 */
export async function restoreGeneralOutputs(localDevices: Set<string>, fallback: CoreOutput) {
  const sessionId = coreSession();
  const playing = coreOutputs(coreView());
  // Nothing picked yet: playing starts on this computer's output anyway.
  if (playing.length === 0) return;
  const signal = serverConnectionSignal();
  const [sessions, endpoints] = await Promise.all([
    coreSessions(),
    fetch(`${serverBaseUrl}/api/endpoints`, { cache: "no-store", signal }).then(
      (response) => (response.ok ? (response.json() as Promise<{ id: string; devices: { id: string }[] }[]>) : null),
    ),
  ]);
  const session = sessions.find((other) => other.id === sessionId);
  // Another stage was chosen on purpose; a server from before stages has no General.
  if (signal.aborted || coreSession() !== sessionId || !endpoints || !session?.stages) return;
  if ((session.activeStage ?? GENERAL_STAGE) !== GENERAL_STAGE) return;
  const inReach = (output: CoreOutput) => {
    if (output.endpointId === fallback.endpointId) return localDevices.has(output.deviceId);
    const endpoint = endpoints.find((other) => other.id === output.endpointId);
    return !!endpoint && (output.deviceId === "" || endpoint.devices.some((device) => device.id === output.deviceId));
  };
  if (playing.some(inReach)) return;
  const picked = (pickedHere()[sessionId] ?? []).filter(inReach);
  const outputs = picked.length > 0 ? picked : [fallback];
  const general = { id: GENERAL_STAGE, name: "General", ...session.stages.find((stage) => stage.id === GENERAL_STAGE), outputs };
  const stages = session.stages.some((stage) => stage.id === GENERAL_STAGE)
    ? session.stages.map((stage) => (stage.id === GENERAL_STAGE ? general : stage))
    : [general, ...session.stages];
  await setCoreStages(sessionId, stages, GENERAL_STAGE);
  await coreCommand("outputs", { outputs });
}

/** Sets a stage's target loudness on every computer it plays on. */
export async function applyLoudnessTarget(
  outputs: CoreOutput[],
  lufs: number,
  audio: ReturnType<typeof useAudioSettings>,
) {
  const outdated: string[] = [];
  const endpoints = new Map(outputs.map((output) => [output.endpointId, output]));
  for (const output of endpoints.values()) {
    if (output.endpointId === serverConnection?.clientId) {
      if (audio && audio.settings.normalizationTargetLufs !== lufs)
        await audio.update((current) => ({ ...current, normalizationTargetLufs: lufs }));
    } else {
      await invokeOn(output, "set_loudness_target", { lufs }).catch(() =>
        outdated.push(output.endpointName),
      );
    }
  }
  if (outdated.length > 0)
    throw new Error(
      `Update Ambra on ${outdated.join(", ")} to use this stage's target loudness.`,
    );
}
