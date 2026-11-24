import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  coreOutputs,
  coreSession,
  coreSessions,
  setCoreStages,
  subscribeCore,
  type CoreOutput,
  type CoreSession,
  type CoreStage,
} from "../api/core";
import { serverConnection } from "../api/serverConnection";
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
