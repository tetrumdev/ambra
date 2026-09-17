import { describe, expect, test } from "bun:test";
import { NativePlaybackCommands } from "../src/utils/nativePlaybackCommands";

describe("native playback command ordering", () => {
  test("a slow skip completes before the next skip and pause", async () => {
    const calls: string[] = [];
    let finishLoad!: () => void;
    const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
    const commands = new NativePlaybackCommands(async (command, args) => {
      calls.push(`${command}:${args?.source ?? ""}`);
      if (args?.source === "first") await loading;
    });

    const first = commands.run("load_native_audio", { source: "first", autoplay: true });
    const second = commands.run("load_native_audio", { source: "second", autoplay: true });
    const pause = commands.run("pause_native_audio");
    await Promise.resolve();
    expect(calls).toEqual(["load_native_audio:first"]);
    expect(commands.acceptsStatus(commands.revision)).toBe(false);
    finishLoad();
    await Promise.all([first, second, pause]);
    expect(calls).toEqual([
      "load_native_audio:first", "load_native_audio:second", "pause_native_audio:",
    ]);
    expect(commands.acceptsStatus(commands.revision)).toBe(true);
  });

  test("rejects an in-flight status response after a new user action", async () => {
    const commands = new NativePlaybackCommands(async () => {});
    const revisionBeforeSkip = commands.revision;
    await commands.run("load_native_audio", { source: "next", autoplay: true });
    expect(commands.acceptsStatus(revisionBeforeSkip)).toBe(false);
    expect(commands.acceptsStatus(commands.revision)).toBe(true);
  });

  test("a failed load does not block the next track", async () => {
    const calls: string[] = [];
    const commands = new NativePlaybackCommands(async (_command, args) => {
      calls.push(String(args?.source));
      if (args?.source === "broken") throw new Error("unavailable");
    });
    const broken = commands.run("load_native_audio", { source: "broken" });
    const next = commands.run("load_native_audio", { source: "next" });
    await expect(broken).rejects.toThrow("unavailable");
    await next;
    expect(calls).toEqual(["broken", "next"]);
    expect(commands.pending).toBe(0);
  });
});
