import { useClientConnection } from "../hooks/ClientConnectionContext";
import { isTauri } from "@tauri-apps/api/core";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { AudioControlsMenu } from "./AudioControlsMenu";
import { useAudioSettings } from "../hooks/AudioSettingsContext";
import { visibleOutputs, type AudioSettings } from "../utils/audioSettings";
import { acceptsPlaybackShortcut } from "../utils/keyboard";
import { matchesShortcut } from "../utils/shortcuts";
import "./ExtraCtrls.css";
import { invokeOn, useEndpoints } from "../utils/playbackTarget";
import {
  coreCommand,
  coreOutputs,
  coreView,
  subscribeCore,
  type CoreOutput,
  type CoreStage,
} from "../api/core";
import { serverConnection } from "../api/serverConnection";
import {
  applyLoudnessTarget,
  GENERAL_STAGE,
  useStages,
} from "../hooks/useStages";
import { MAX_TARGET_LUFS, MIN_TARGET_LUFS } from "../utils/audioSettings";

/** How far keyboard and wheel input change the volume, in percent. */
const VOLUME_STEP = 5;
/** Where unmuting goes for an output that was already silent when muted. */
const UNMUTE_FALLBACK_VOLUME = 50;
// Each output's level before M muted it, so M restores it.
const levelsBeforeMute = new Map<string, number>();

function clampVolume(volume: number) {
  return Math.min(100, Math.max(0, volume));
}

function outputKey(output: { endpointId: string; deviceId: string }) {
  return `${output.endpointId}:${output.deviceId}`;
}

/** The same outputs, in any order. */
function sameOutputs(left: CoreOutput[], right: CoreOutput[]) {
  const keys = new Set(left.map(outputKey));
  return (
    left.length === right.length &&
    right.every((output) => keys.has(outputKey(output)))
  );
}

const volumeLevels = ["muted", "mid", "high"] as const;
function volumeLevel(volume: number) {
  return volume <= 0 ? "muted" : volume < 50 ? "mid" : "high";
}

/** A stage being made or changed in the volume menu. */
type StageDraft = {
  id: string | null;
  name: string;
  outputs: CoreOutput[];
  targetLufs: string;
};

type ExtraCtrlsProps = {
  onToggleQueue?: () => void;
  queueSidebarOpen?: boolean;
};

export function ExtraCtrls({
  onToggleQueue,
  queueSidebarOpen,
}: ExtraCtrlsProps) {
  const hasNativeAudio = isTauri();
  const audio = useAudioSettings();
  const isChangingDevice = audio?.saving ?? false;
  const isLoadingDevices = audio?.loading ?? false;
  const selectedDeviceId = audio?.settings.selectedOutputId ?? "";
  const audioDevices = audio
    ? visibleOutputs(audio.settings, audio.devices)
    : [];
  const showAudioModeToggle = hasNativeAudio;
  const [volumePreview, setVolumePreview] = useState<{
    outputId: string;
    volume: number;
  } | null>(null);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  // With a server, its core picks the output from every computer's; the volume lives on the
  // computer that output belongs to.
  const shared = useClientConnection().sharedPlayback;
  const sharedCore = useSyncExternalStore(subscribeCore, coreView);
  const core = shared ? sharedCore : null;
  const coreOutput = core?.output ?? null;
  const target =
    coreOutput && coreOutput.endpointId !== serverConnection?.clientId
      ? coreOutput
      : null;
  const endpoints = useEndpoints(audioMenuOpen && core !== null, true);
  // Stages: the session's named groups of outputs, played on together in step, each with its
  // own volumes and target loudness. General is the one whose outputs are picked in the list.
  const {
    stages,
    activeStage,
    save: saveStages,
  } = useStages(core !== null, audioMenuOpen);
  const [editing, setEditing] = useState<StageDraft | null>(null);
  useEffect(() => {
    if (!audioMenuOpen) setEditing(null);
  }, [audioMenuOpen]);
  const isPlayingHere = (deviceId: string) =>
    core
      ? coreOutput?.endpointId === serverConnection?.clientId &&
        coreOutput?.deviceId === deviceId
      : selectedDeviceId === deviceId;
  const pickHere = (deviceId: string, deviceName: string) => {
    if (core && serverConnection)
      chooseOutput({
        endpointId: serverConnection.clientId,
        deviceId,
        endpointName: serverConnection.clientName,
        deviceName,
      });
    else void selectAudioDevice(deviceId);
  };
  const [targetError, setTargetError] = useState<string | null>(null);
  // The server switched this computer's output; its settings say which one now.
  const ownDeviceId = coreOutput && !target ? coreOutput.deviceId : null;
  useEffect(() => {
    if (
      ownDeviceId !== null &&
      ownDeviceId !== audio?.settings.selectedOutputId
    )
      void audio?.refresh();
  }, [ownDeviceId]);
  const pendingVolumes = useRef(
    new Map<string, { outputId: string; volume: number }>(),
  );
  const isSendingVolume = useRef(false);
  const volumeButton = useRef<HTMLButtonElement>(null);

  // Every output playing keeps its own volume, set from the slider under it; the volume button
  // shows the leading one's, and keys and the wheel move them all together.
  const groupOutputs = coreOutputs(core);
  const isOnThisComputer = (output: CoreOutput) =>
    output.endpointId === serverConnection?.clientId;
  const [remoteVolumes, setRemoteVolumes] = useState<Record<string, number>>(
    {},
  );
  const [remoteExclusive, setRemoteExclusive] = useState<
    Record<string, boolean>
  >({});
  const remoteMembers = groupOutputs.filter(
    (member) => !isOnThisComputer(member),
  );
  const remoteMembersKey = remoteMembers.map(outputKey).join("|");
  useEffect(() => {
    if (remoteMembers.length === 0) return;
    let disposed = false;
    for (const member of remoteMembers) {
      // Each output's own saved level: `native_audio_volume` answers only for the app's own player
      // there, so every other output on that computer would show (and step from) its level.
      void invokeOn<AudioSettings>(member, "native_audio_settings")
        .then((settings) => {
          const own = settings.outputs.find(
            (output) => output.id === member.deviceId,
          );
          if (disposed) return;
          setRemoteVolumes((current) => ({
            ...current,
            [outputKey(member)]: own?.volume ?? 100,
          }));
          setRemoteExclusive((current) => ({
            ...current,
            [outputKey(member)]: own?.exclusiveMode ?? false,
          }));
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
    };
  }, [remoteMembersKey, audioMenuOpen]);
  const localVolume = (deviceId: string) =>
    volumePreview?.outputId === deviceId
      ? volumePreview.volume
      : (audio?.settings.outputs.find((output) => output.id === deviceId)
          ?.volume ?? 100);
  // Exclusive mode plays the samples untouched, so its volume can't be changed.
  const localExclusive = (deviceId: string) =>
    audio?.settings.outputs.find((output) => output.id === deviceId)
      ?.exclusiveMode ?? false;
  const isExclusive = (output: CoreOutput) =>
    isOnThisComputer(output)
      ? localExclusive(output.deviceId)
      : (remoteExclusive[outputKey(output)] ?? false);
  const memberVolume = (output: CoreOutput) =>
    isOnThisComputer(output)
      ? localVolume(output.deviceId)
      : (remoteVolumes[outputKey(output)] ?? 100);
  // Levels just set, ahead of the render showing them, so wheel steps build on one another.
  const recentLevels = useRef(
    new Map<string, { volume: number; at: number }>(),
  );
  const currentLevel = (output: CoreOutput) => {
    const recent = recentLevels.current.get(outputKey(output));
    return recent && performance.now() - recent.at < 1000
      ? recent.volume
      : memberVolume(output);
  };
  const remoteVolumeTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  // Levels set while a stage plays are kept as that stage's, sent once the change settles.
  const stageLevels = useRef(new Map<string, number>());
  const stageLevelsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rememberStageLevel = (output: CoreOutput, level: number) => {
    if (!stages) return;
    stageLevels.current.set(outputKey(output), level);
    clearTimeout(stageLevelsTimer.current);
    stageLevelsTimer.current = setTimeout(() => {
      const levels = Object.fromEntries(stageLevels.current);
      stageLevels.current.clear();
      void saveStages((list, activeId) =>
        list.map((stage) =>
          stage.id === activeId
            ? { ...stage, volumes: { ...stage.volumes, ...levels } }
            : stage,
        ),
      ).catch((error) => setTargetError(String(error)));
    }, 600);
  };
  const setMemberVolume = (
    output: CoreOutput,
    nextVolume: number,
    remember = true,
  ) => {
    const key = outputKey(output);
    if (remember) rememberStageLevel(output, nextVolume);
    recentLevels.current.set(key, {
      volume: nextVolume,
      at: performance.now(),
    });
    if (isOnThisComputer(output)) {
      setLocalVolume(output.deviceId, nextVolume);
      return;
    }
    setRemoteVolumes((current) => ({ ...current, [key]: nextVolume }));
    // A drag sends its latest level, not every step, over the network.
    clearTimeout(remoteVolumeTimers.current.get(key));
    remoteVolumeTimers.current.set(
      key,
      setTimeout(() => {
        remoteVolumeTimers.current.delete(key);
        void coreCommand("volume", { volume: nextVolume, output }).catch(
          (error) => setTargetError(String(error)),
        );
      }, 80),
    );
  };
  // The button shows the shared level, "Var" when the outputs differ or some are exclusive, and
  // nothing when all are exclusive.
  const levels =
    groupOutputs.length > 0
      ? groupOutputs.filter((output) => !isExclusive(output)).map(memberVolume)
      : localExclusive(selectedDeviceId)
        ? []
        : [localVolume(selectedDeviceId)];
  const someExclusive =
    groupOutputs.length > 0
      ? levels.length < groupOutputs.length
      : levels.length === 0;
  const volume = levels.length > 0 ? Math.max(...levels) : 100;
  const volumeReadout =
    levels.length === 0
      ? null
      : someExclusive || levels.some((level) => level !== levels[0])
        ? "Var"
        : `${Math.round(levels[0])}%`;

  const sameOutput = (output: CoreOutput) => (member: CoreOutput) =>
    member.endpointId === output.endpointId &&
    member.deviceId === output.deviceId;
  const inGroup = (output: CoreOutput) => groupOutputs.some(sameOutput(output));
  const run = (work: Promise<unknown>) => {
    setTargetError(null);
    void work.catch((error) => setTargetError(String(error)));
  };
  // Plays on a stage's outputs at its levels and target loudness.
  const activate = async (stage: CoreStage) => {
    if (stage.outputs.length > 0 && !sameOutputs(stage.outputs, groupOutputs))
      await coreCommand("outputs", { outputs: stage.outputs });
    for (const output of stage.outputs) {
      const level = stage.volumes?.[outputKey(output)];
      if (level !== undefined && !isExclusive(output))
        setMemberVolume(output, level, false);
    }
    if (stage.targetLufs !== undefined)
      await applyLoudnessTarget(stage.outputs, stage.targetLufs, audio);
  };
  const playStage = (stage: CoreStage) =>
    run(saveStages((list) => list, stage.id).then(() => activate(stage)));
  const general = stages?.find((stage) => stage.id === GENERAL_STAGE) ?? null;
  // Picking outputs by hand plays them on the General stage.
  const playGeneral = (outputs: CoreOutput[]) => {
    // A server from before stages: as before, a row plays there alone.
    if (!general) {
      run(coreCommand("output", { output: outputs[0] }));
      return;
    }
    const stage = { ...general, outputs };
    run(
      saveStages(
        (list) =>
          list.map((other) => (other.id === GENERAL_STAGE ? stage : other)),
        GENERAL_STAGE,
      ).then(() => activate(stage)),
    );
  };
  const chooseOutput = (output: CoreOutput) => playGeneral([output]);
  const toggleGeneral = (output: CoreOutput) => {
    const next = inGroup(output)
      ? groupOutputs.filter((member) => !sameOutput(output)(member))
      : [...groupOutputs, output];
    if (next.length > 0) playGeneral(next);
  };

  const openEditor = (stage: CoreStage | null) =>
    setEditing({
      id: stage?.id ?? null,
      name: stage?.name ?? "",
      outputs: stage?.outputs ?? [...groupOutputs],
      targetLufs: String(
        stage?.targetLufs ??
          audio?.settings.normalizationTargetLufs ??
          MAX_TARGET_LUFS,
      ),
    });
  const draftTarget = Number(editing?.targetLufs);
  const draftValid =
    editing !== null &&
    editing.name.trim() !== "" &&
    (editing.id === GENERAL_STAGE || editing.outputs.length > 0) &&
    editing.targetLufs.trim() !== "" &&
    draftTarget >= MIN_TARGET_LUFS &&
    draftTarget <= MAX_TARGET_LUFS;
  const saveDraft = () => {
    if (!editing || !stages || !draftValid) return;
    const existing = stages.find((stage) => stage.id === editing.id);
    const stage: CoreStage = {
      ...(existing ?? {
        id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      }),
      name: editing.name.trim(),
      // General's outputs are picked in the list, not here.
      outputs:
        existing?.id === GENERAL_STAGE ? existing.outputs : editing.outputs,
      targetLufs: draftTarget,
    };
    // A new stage plays at once; changing the one playing changes what plays.
    const playing = !existing || stage.id === activeStage?.id;
    setEditing(null);
    run(
      saveStages(
        (list) =>
          existing
            ? list.map((other) => (other.id === stage.id ? stage : other))
            : [...list, stage],
        playing ? stage.id : undefined,
      ).then(() => (playing ? activate(stage) : undefined)),
    );
  };
  // Removing the stage playing goes back to General, still on the same outputs.
  const deleteStage = (id: string) => {
    const wasPlaying = id === activeStage?.id;
    const nextGeneral = general && { ...general, outputs: groupOutputs };
    setEditing(null);
    run(
      saveStages(
        (list) =>
          list
            .filter((stage) => stage.id !== id)
            .map((stage) =>
              wasPlaying && nextGeneral && stage.id === GENERAL_STAGE
                ? nextGeneral
                : stage,
            ),
        wasPlaying ? GENERAL_STAGE : undefined,
      ).then(() =>
        wasPlaying && nextGeneral ? activate(nextGeneral) : undefined,
      ),
    );
  };
  const toggleDrafted = (output: CoreOutput) =>
    setEditing(
      (current) =>
        current && {
          ...current,
          outputs: current.outputs.some(sameOutput(output))
            ? current.outputs.filter((member) => !sameOutput(output)(member))
            : [...current.outputs, output],
        },
    );
  // On General, the row plays there alone and the box beside it adds or removes the output; on
  // another stage, the rows only show its outputs and their volumes.
  const groupRow = (
    output: CoreOutput,
    label: string,
    {
      syncs,
      disabled = false,
      offline = false,
      fixed = false,
    }: { syncs: boolean; disabled?: boolean; offline?: boolean; fixed?: boolean },
  ) => {
    const playing = inGroup(output);
    const picking = !fixed && general !== null;
    const exclusive = isExclusive(output);
    const level = memberVolume(output);
    const name = (
      <>
        <span className="uiMenuCheck" aria-hidden="true" />
        <span className="audioDeviceName" data-tooltip={label}>
          {offline ? `${output.deviceName} (offline)` : output.deviceName}
        </span>
      </>
    );
    return (
      <Fragment key={outputKey(output)}>
        <div className="audioDeviceRow">
          {fixed ? (
            <div
              className="uiMenuOption audioDeviceFixed"
              aria-current={playing || undefined}
            >
              {name}
            </div>
          ) : (
            <button
              className="uiMenuOption"
              type="button"
              aria-current={(!picking && playing) || undefined}
              aria-label={label}
              disabled={disabled || offline}
              onClick={() => chooseOutput(output)}
            >
              {name}
            </button>
          )}
          {picking && (
            <button
              className="audioDeviceToggle"
              type="button"
              role="checkbox"
              aria-checked={playing}
              aria-label={`Play on ${label} too`}
              data-tooltip={
                syncs ? undefined : "Update Ambra there to play in sync"
              }
              disabled={
                disabled ||
                offline ||
                !syncs ||
                (playing && groupOutputs.length === 1)
              }
              onClick={() => toggleGeneral(output)}
            >
              <span className="audioDeviceBox" aria-hidden="true" />
            </button>
          )}
        </div>
        {playing && !offline && (
          <div
            className="audioDeviceVolume"
            data-tooltip={
              exclusive ? "Exclusive mode plays at full volume" : undefined
            }
          >
            <input
              className="volumeSlider"
              type="range"
              min="0"
              max="100"
              step="1"
              value={level}
              disabled={exclusive}
              aria-label={`${label} volume`}
              aria-valuetext={exclusive ? "Exclusive" : `${Math.round(level)}%`}
              onChange={(event) =>
                setMemberVolume(output, Number(event.target.value))
              }
              style={{ "--volume": `${level}%` } as CSSProperties}
            />
          </div>
        )}
      </Fragment>
    );
  };
  const here = core && serverConnection ? serverConnection : null;
  // Outputs playing that the list doesn't show, because their computer is out of reach.
  const offlineMembers = groupOutputs.filter(
    (member) =>
      member.endpointId !== here?.clientId &&
      !endpoints.some((endpoint) => endpoint.id === member.endpointId),
  );
  // Every computer's outputs in one list, by name: renaming them is how they're told apart and
  // kept in order, not which computer they're on.
  const outputRows = here
    ? [
        ...audioDevices.map((device) => ({
          output: {
            endpointId: here.clientId,
            deviceId: device.id,
            endpointName: here.clientName,
            deviceName: device.name,
          },
          syncs: true,
          disabled: isChangingDevice,
          offline: false,
        })),
        ...endpoints.flatMap((endpoint) =>
          endpoint.devices.map((device) => ({
            output: {
              endpointId: endpoint.id,
              endpointName: endpoint.name,
              deviceId: device.id,
              deviceName: device.name,
            },
            syncs: endpoint.syncs,
            disabled: false,
            offline: false,
          })),
        ),
        ...offlineMembers.map((output) => ({
          output,
          syncs: true,
          disabled: false,
          offline: true,
        })),
      ].sort(
        (a, b) =>
          a.output.deviceName.localeCompare(b.output.deviceName, undefined, {
            sensitivity: "base",
            numeric: true,
          }) || a.output.endpointName.localeCompare(b.output.endpointName),
      )
    : [];

  const selectAudioDevice = async (deviceId: string) => {
    if (!audio || audio.saving) return;
    setTargetError(null);
    await audio.update((current) => ({
      ...current,
      selectedOutputId: deviceId,
    }));
  };

  const sendPendingVolume = async () => {
    if (!audio || isSendingVolume.current) return;

    isSendingVolume.current = true;
    try {
      while (pendingVolumes.current.size > 0) {
        const next = pendingVolumes.current.values().next().value!;
        pendingVolumes.current.delete(next.outputId);
        await audio.update((current) => ({
          ...current,
          outputs: current.outputs.map((output) =>
            output.id === next.outputId
              ? { ...output, volume: next.volume }
              : output,
          ),
        }));
        setVolumePreview((current) => (current === next ? null : current));
      }
    } finally {
      isSendingVolume.current = false;
    }
  };

  // Follows each change at once, so wheel events arriving between renders build on one another.
  const latestVolume = useRef(volume);
  latestVolume.current = volume;
  function setLocalVolume(outputId: string, nextVolume: number) {
    if (!audio || audio.loading) return;
    const next = { outputId, volume: nextVolume };
    setVolumePreview(next);
    pendingVolumes.current.set(next.outputId, next);
    void sendPendingVolume();
  }
  // Moves every output playing by the same step, keeping the gaps between their levels: the
  // loudest stops at 100 and the quietest at 0. Exclusive outputs stay as they are.
  const stepVolume = (step: number) => {
    if (groupOutputs.length === 0) {
      if (localExclusive(selectedDeviceId)) return;
      const next = clampVolume(latestVolume.current + step);
      if (next === latestVolume.current) return;
      latestVolume.current = next;
      setLocalVolume(selectedDeviceId, next);
      return;
    }
    const members = groupOutputs.filter((output) => !isExclusive(output));
    if (members.length === 0) return;
    const levels = members.map(currentLevel);
    const move =
      step > 0
        ? Math.min(step, 100 - Math.max(...levels))
        : Math.max(step, -Math.min(...levels));
    if (move === 0) return;
    members.forEach((output, index) =>
      setMemberVolume(output, levels[index] + move),
    );
  };

  // Up/Down move between devices, as in a native menu.
  const moveDeviceFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ".uiMenuOption:not(:disabled)",
      ),
    ];
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(current + step + options.length) % options.length]?.focus();
  };

  const closeAudioMenu = () => {
    setAudioMenuOpen(false);
    volumeButton.current?.focus();
  };

  // Mutes every output playing, and gives each its own level back.
  const toggleMute = () => {
    if (groupOutputs.length === 0) {
      if (localExclusive(selectedDeviceId)) return;
      const muting = latestVolume.current > 0;
      if (muting) levelsBeforeMute.set(selectedDeviceId, latestVolume.current);
      const next = muting
        ? 0
        : (levelsBeforeMute.get(selectedDeviceId) ?? UNMUTE_FALLBACK_VOLUME);
      latestVolume.current = next;
      setLocalVolume(selectedDeviceId, next);
      return;
    }
    const members = groupOutputs.filter((output) => !isExclusive(output));
    const muting = members.some((output) => currentLevel(output) > 0);
    for (const output of members) {
      const key = outputKey(output);
      if (muting) {
        const level = currentLevel(output);
        if (level > 0) levelsBeforeMute.set(key, level);
        setMemberVolume(output, 0);
      } else {
        setMemberVolume(
          output,
          levelsBeforeMute.get(key) ?? UNMUTE_FALLBACK_VOLUME,
        );
      }
    }
  };

  // M mutes and unmutes; Up and Down step the volume, repeating while held.
  const shortcuts = useRef({ toggleMute, stepVolume });
  shortcuts.current = { toggleMute, stepVolume };
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const step = matchesShortcut(event, "volumeUp")
        ? VOLUME_STEP
        : matchesShortcut(event, "volumeDown")
          ? -VOLUME_STEP
          : 0;
      if (step !== 0) {
        if (!acceptsPlaybackShortcut(event, true, true)) return;
        event.preventDefault();
        shortcuts.current.stepVolume(step);
      } else if (
        matchesShortcut(event, "toggleMute") &&
        acceptsPlaybackShortcut(event, false, true)
      ) {
        event.preventDefault();
        if (event.repeat) return;
        shortcuts.current.toggleMute();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Wheel distances vary between platforms; each vertical event moves one fixed step.
  const volumeControl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const control = volumeControl.current;
    if (!control) return;
    const handleWheel = (event: WheelEvent) => {
      // The output list in the open menu scrolls as usual.
      if (
        event.target instanceof Element &&
        event.target.closest(".audioDeviceList")
      )
        return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      shortcuts.current.stepVolume(-Math.sign(event.deltaY) * VOLUME_STEP);
    };
    control.addEventListener("wheel", handleWheel, { passive: false });
    return () => control.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <div id="extraCtrls">
      <div className="volumeControlContainer" ref={volumeControl}>
        {hasNativeAudio && audioMenuOpen && (
          <AudioControlsMenu anchor={volumeButton} onClose={closeAudioMenu}>
            {showAudioModeToggle && editing && (
              <form
                className="audioStageEditor"
                aria-label={editing.id ? `Edit ${editing.name}` : "New stage"}
                onSubmit={(event) => {
                  event.preventDefault();
                  saveDraft();
                }}
              >
                <div className="audioStageEditorHeader">
                  <label className="audioDeviceHeading" htmlFor="audioStageName">
                    Stage name
                  </label>
                  {editing.id && editing.id !== GENERAL_STAGE && (
                    <button
                      className="audioStageIconButton"
                      type="button"
                      aria-label="Delete stage"
                      data-tooltip="Delete stage"
                      onClick={() => deleteStage(editing.id!)}
                    >
                      <img src="/delete.svg" alt="" />
                    </button>
                  )}
                </div>
                <input
                  id="audioStageName"
                  className="uiField audioStageName"
                  type="text"
                  maxLength={60}
                  autoFocus
                  value={editing.name}
                  onChange={(event) =>
                    setEditing({ ...editing, name: event.target.value })
                  }
                />
                {editing.id !== GENERAL_STAGE && (
                  <>
                    <span className="audioDeviceHeading" aria-hidden="true">
                      Enabled outputs
                    </span>
                    <div
                      className="audioStageChips"
                      role="group"
                      aria-label="Enabled outputs"
                    >
                      {[
                        ...outputRows,
                        // Outputs out of reach now stay on the stage unless untoggled.
                        ...editing.outputs
                          .filter(
                            (output) =>
                              !outputRows.some((row) =>
                                sameOutput(output)(row.output),
                              ),
                          )
                          .map((output) => ({ output, syncs: true })),
                      ].map(({ output, syncs }) => {
                        const picked = editing.outputs.some(sameOutput(output));
                        return (
                          <button
                            key={outputKey(output)}
                            className="audioStageChip"
                            type="button"
                            aria-pressed={picked}
                            aria-label={`${output.deviceName} on ${output.endpointName}`}
                            data-tooltip={
                              syncs
                                ? output.endpointName
                                : "Update Ambra there to play in sync"
                            }
                            disabled={!syncs && !picked}
                            onClick={() => toggleDrafted(output)}
                          >
                            {output.deviceName}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                <label className="audioStageField">
                  <span className="audioDeviceHeading">Target loudness</span>
                  <span className="audioStageLufs">
                    <input
                      className="uiField"
                      type="number"
                      min={MIN_TARGET_LUFS}
                      max={MAX_TARGET_LUFS}
                      step={0.1}
                      value={editing.targetLufs}
                      onChange={(event) =>
                        setEditing({ ...editing, targetLufs: event.target.value })
                      }
                    />
                    <small>LUFS</small>
                  </span>
                </label>
                <div className="audioStageEditorFooter">
                  <button
                    className="uiButton"
                    type="button"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="uiButton uiButtonPrimary"
                    type="submit"
                    disabled={!draftValid}
                  >
                    {editing.id ? "Save" : "Create"}
                  </button>
                </div>
              </form>
            )}
            {showAudioModeToggle && !editing && (
              <>
                <div
                  className="audioDeviceList"
                  role={here ? "group" : "radiogroup"}
                  aria-label="Audio output device"
                  onKeyDown={moveDeviceFocus}
                >
                  {here && stages && activeStage && (
                    <>
                      <span className="audioDeviceHeading" aria-hidden="true">
                        Stages
                      </span>
                      <div
                        className="audioStageGrid"
                        role="radiogroup"
                        aria-label="Stages"
                      >
                        {stages.map((stage) => (
                          <div
                            key={stage.id}
                            className="audioStageTile"
                            data-selected={
                              stage.id === activeStage.id || undefined
                            }
                          >
                            <button
                              className="audioStagePick"
                              type="button"
                              role="radio"
                              aria-checked={stage.id === activeStage.id}
                              onClick={() => playStage(stage)}
                            >
                              {stage.name}
                            </button>
                            <button
                              className="audioStageIconButton"
                              type="button"
                              aria-label={`Edit the ${stage.name} stage`}
                              data-tooltip="Edit stage"
                              onClick={() => openEditor(stage)}
                            >
                              <img src="/edit.svg" alt="" />
                            </button>
                          </div>
                        ))}
                        <button
                          className="audioStageAdd"
                          type="button"
                          aria-label="New stage"
                          data-tooltip="New stage"
                          onClick={() => openEditor(null)}
                        >
                          <img src="/add.svg" alt="" />
                        </button>
                      </div>
                      <hr className="audioStageDivider" />
                    </>
                  )}
                  <span className="audioDeviceHeading" aria-hidden="true">
                    {here ? "Outputs" : "Output"}
                  </span>
                  {isLoadingDevices ? (
                    <button
                      className="uiMenuOption"
                      type="button"
                      role="radio"
                      aria-checked={false}
                      disabled
                    >
                      <span className="uiMenuCheck" aria-hidden="true" />
                      <span className="audioDeviceName">Loading devices…</span>
                    </button>
                  ) : here && activeStage && activeStage !== general ? (
                    activeStage.outputs.map((output) =>
                      groupRow(
                        output,
                        `${output.deviceName} on ${output.endpointName}`,
                        {
                          syncs: true,
                          fixed: true,
                          offline: !outputRows.some(
                            (row) =>
                              !row.offline && sameOutput(output)(row.output),
                          ),
                        },
                      ),
                    )
                  ) : here ? (
                    outputRows.map(({ output, ...state }) =>
                      groupRow(
                        output,
                        `${output.deviceName} on ${output.endpointName}`,
                        state,
                      ),
                    )
                  ) : (
                    audioDevices.map((device) => (
                      <button
                        key={device.id || "system-default"}
                        className="uiMenuOption"
                        type="button"
                        role="radio"
                        aria-checked={isPlayingHere(device.id)}
                        disabled={isChangingDevice}
                        onClick={() => pickHere(device.id, device.name)}
                      >
                        <span className="uiMenuCheck" aria-hidden="true" />
                        <span
                          className="audioDeviceName"
                          data-tooltip={device.name}
                          data-tooltip-overflow=""
                        >
                          {device.name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
            {targetError && (
              <p className="audioControlsError" role="alert">
                {targetError}
              </p>
            )}
            {audio?.error && (
              <p className="audioControlsError" role="alert">
                {audio.error}
              </p>
            )}
            {audioDevices.length === 0 && !isLoadingDevices && (
              <p className="audioControlsNote">Enable outputs in Settings.</p>
            )}
            {/* With a server, each output playing has its own slider in the list instead. */}
            {!here && (
              <input
                className="volumeSlider"
                type="range"
                min="0"
                max="100"
                step="1"
                disabled={isLoadingDevices || localExclusive(selectedDeviceId)}
                value={volume}
                aria-label="Volume"
                aria-valuetext={`${Math.round(volume)}%`}
                onChange={(event) => {
                  latestVolume.current = Number(event.target.value);
                  setLocalVolume(selectedDeviceId, Number(event.target.value));
                }}
                style={{ "--volume": `${volume}%` } as CSSProperties}
              />
            )}
          </AudioControlsMenu>
        )}
        <button
          ref={volumeButton}
          id="volumeBtn"
          type="button"
          aria-label={volume <= 0 ? "Volume (muted)" : "Volume"}
          data-tooltip={hasNativeAudio ? "Volume and output device" : "Volume"}
          aria-haspopup={hasNativeAudio ? "dialog" : undefined}
          aria-expanded={hasNativeAudio ? audioMenuOpen : undefined}
          onClick={() => {
            if (!hasNativeAudio) return;
            if (audioMenuOpen) {
              closeAudioMenu();
              return;
            }
            void audio?.refresh();
            setAudioMenuOpen(true);
          }}
        >
          {/* Every level stays loaded, so changing level never waits on an image and blinks out. */}
          <span
            id="volumeImg"
            data-level={volumeLevel(volume)}
            aria-hidden="true"
          >
            {volumeLevels.map((level) => (
              <img
                key={level}
                src={`/volume-${level}.svg`}
                alt=""
                data-level={level}
              />
            ))}
          </span>
        </button>
        <span className="volumePercentage" aria-live="polite">
          {volumeReadout}
        </span>
      </div>
      <button
        id="queueBtn"
        type="button"
        aria-label="Queue"
        aria-expanded={queueSidebarOpen}
        aria-controls={queueSidebarOpen ? "playbackSidebar" : undefined}
        onClick={onToggleQueue}
        onKeyDown={(event) => {
          if (event.key === " ") event.stopPropagation();
        }}
        data-tooltip="Queue"
      >
        <img src="/queue.svg" alt="" id="queueImg" />
      </button>
    </div>
  );
}
