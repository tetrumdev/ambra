import { expect, test } from "bun:test";
import { defaultAudioSettings, enabledOutputsFirst, visibleOutputs, type OutputSettings } from "../src/utils/audioSettings";

function output(id: string, enabled: boolean): OutputSettings {
  return { ...defaultAudioSettings().outputs[0], id, name: id || "System Default", enabled };
}

test("fresh audio settings enable only System Default", () => {
  const settings = defaultAudioSettings();
  expect(settings.selectedOutputId).toBe("");
  expect(settings.outputs).toEqual([output("", true)]);
});

test("enabled outputs sort first without changing saved or within-group order", () => {
  const outputs = [output("hdmi", false), output("headphones", true), output("", true), output("speakers", false)];
  const original = [...outputs];
  const sorted = enabledOutputsFirst(outputs);
  expect(sorted.map(item => item.id)).toEqual(["headphones", "", "hdmi", "speakers"]);
  expect(outputs).toEqual(original);
  expect(sorted[0]).toBe(outputs[1]);
  expect(enabledOutputsFirst([])).toEqual([]);
});

test("enabling and disabling devices immediately changes their display group", () => {
  const outputs = [output("", true), output("hdmi", false), output("headphones", false)];
  const enabled = outputs.map(item => item.id === "headphones" ? { ...item, enabled: true } : item);
  expect(enabledOutputsFirst(enabled).map(item => item.id)).toEqual(["", "headphones", "hdmi"]);
  const disabled = enabled.map(item => item.id === "" ? { ...item, enabled: false } : item);
  expect(enabledOutputsFirst(disabled).map(item => item.id)).toEqual(["headphones", "", "hdmi"]);
});

test("player picker excludes disabled and disconnected devices", () => {
  const settings = { ...defaultAudioSettings(), outputs: [output("", true), output("hdmi", false), output("headphones", true), output("disconnected", true)] };
  const devices = [{ id: "hdmi", name: "HDMI", isDefault: true }, { id: "headphones", name: "Headphones", isDefault: false }];
  expect(visibleOutputs(settings, devices).map(item => item.id)).toEqual(["", "headphones"]);
});
