import { describe, expect, test } from "bun:test";
import { createOutputMediaControlHandler } from "../src/utils/outputMediaControls";

describe("headset and OS media controls", () => {
  const actions = ["play", "pause", "toggle", "next", "previous"];

  test("cannot change playback on a different output endpoint", () => {
    const sent: string[] = [];
    const handle = createOutputMediaControlHandler("laptop", () => ({ endpointId: "sound-system" }), async action => { sent.push(action); });
    actions.forEach(handle);
    expect(sent).toEqual([]);
  });

  test("work for this endpoint, including resuming paused playback", () => {
    const sent: string[] = [];
    const handle = createOutputMediaControlHandler("laptop", () => ({ endpointId: "laptop" }), async action => { sent.push(action); });
    actions.forEach(handle);
    handle("unsupported");
    expect(sent).toEqual(actions);
  });

  test("recheck the output when a queued headset event arrives after a handoff", () => {
    let output: { endpointId: string } | null = { endpointId: "laptop" };
    const sent: string[] = [];
    const handle = createOutputMediaControlHandler("laptop", () => output, async action => { sent.push(action); });
    handle("play");
    output = { endpointId: "sound-system" };
    actions.forEach(handle);
    output = { endpointId: "laptop" };
    handle("pause");
    expect(sent).toEqual(["play", "pause"]);
  });

  test("cannot pick an output or claim playback when none is selected", () => {
    const sent: string[] = [];
    const handle = createOutputMediaControlHandler("laptop", () => null, async action => { sent.push(action); });
    actions.forEach(handle);
    expect(sent).toEqual([]);
  });

  test("ignore hardware events before this client has an identity", () => {
    const sent: string[] = [];
    const handle = createOutputMediaControlHandler(undefined, () => ({ endpointId: "laptop" }), async action => { sent.push(action); });
    actions.forEach(handle);
    expect(sent).toEqual([]);
  });
});
