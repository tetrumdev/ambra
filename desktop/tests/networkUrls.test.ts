import { expect, test } from "bun:test";
import { forStorage, fromStorage, setServerForTesting } from "../src/api/serverConnection";
test("bridge capabilities and bearer tokens never enter persisted media URLs", () => {
  const capability = "a".repeat(64);
  setServerForTesting(`http://127.0.0.1:49999/${capability}`, null);
  const saved = forStorage(JSON.stringify({ audio: `http://127.0.0.1:49999/${capability}/api/song?quality=lossless&access_token=old` }));
  expect(saved).not.toContain(capability); expect(saved).not.toContain("access_token");
  const restored = JSON.parse(fromStorage(saved));
  expect(restored.audio).toBe(`http://127.0.0.1:49999/${capability}/api/song?quality=lossless`);
});
test("old bridge addresses rebase to the current selected bridge", () => {
  setServerForTesting(`http://127.0.0.1:50000/${"b".repeat(64)}`, null);
  expect(fromStorage(`http://127.0.0.1:49999/${"a".repeat(64)}/api/song?access_token=old`)).toBe(`http://127.0.0.1:50000/${"b".repeat(64)}/api/song`);
});
