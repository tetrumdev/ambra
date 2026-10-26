import { describe, expect, test } from "bun:test";
import { ActivitySession, activitySnapshot, type ActivityHandle, type ActivitySnapshot } from "../../mobile/src/activitySession";
import type { SessionView } from "../../mobile/src/client";

const view: SessionView = {
  instanceId: "server", revision: 1, playing: true, positionSeconds: 30, duration: 200,
  buffering: false, error: null, output: { endpointId: "desk", deviceId: "speakers", endpointName: "Desk", deviceName: "Speakers" },
  outputOnline: true, queueRevision: 1,
  queue: { current: { globalTrackId: "song" }, upcoming: [], tracks: [{ globalId: "song", provider: "qobuz", name: "Song", artist: "Artist", album: "Album", cover: "http://server/art", nativeCover: null, durationSeconds: 200 }] },
};
const snapshot = (title = "Song") => ({ ...activitySnapshot(view, 2, 100000)!, title });

describe("Live Activity session", () => {
  test("the OS timer follows playback age, holds during pause/buffering, and clamps at the end", () => {
    const running = snapshot();
    expect(running.position).toBe(32);
    expect(running.startAt).toBe(68000);
    expect(running.endAt).toBe(268000);
    expect(activitySnapshot({ ...view, playing: false }, 20, 100000)?.position).toBe(30);
    expect(activitySnapshot({ ...view, buffering: true }, 20, 100000)?.playing).toBe(false);
    expect(activitySnapshot({ ...view, positionSeconds: 199 }, 5, 100000)?.position).toBe(200);
    expect(activitySnapshot(view, 91, 100000)).toBeNull();
    expect(activitySnapshot({ ...view, output: null }, 0, 100000)).toBeNull();
  });

  function harness(recovered: ActivityHandle[] = []) {
    const updated: ActivitySnapshot[] = [];
    const leases: boolean[] = [];
    let starts = 0, ends = 0, foreground = true;
    const handle: ActivityHandle = {
      update: async props => { updated.push(props); },
      end: async () => { ends++; },
    };
    const session = new ActivitySession({
      recover: () => recovered,
      start: () => { starts++; return handle; },
      foreground: () => foreground,
      keepAlive: async active => { leases.push(active); },
    });
    return { session, updated, leases, counts: () => ({ starts, ends }), background: () => { foreground = false; } };
  }

  test("rapid skips coalesce to the latest song and stop releases the background lease", async () => {
    const h = harness();
    await Promise.all([h.session.sync(snapshot("first")), h.session.sync(snapshot("second")), h.session.sync(snapshot("latest"))]);
    expect(h.updated.map(props => props.title)).toEqual(["latest"]);
    expect(h.counts().starts).toBe(1);
    await h.session.sync(null);
    expect(h.leases.at(-1)).toBe(false);
    expect(h.counts().ends).toBe(1);
  });

  test("an activity is only started in the foreground, then keeps updating while locked", async () => {
    const h = harness();
    await h.session.sync(snapshot());
    h.background();
    await h.session.sync(snapshot("next song"));
    expect(h.updated.map(props => props.title)).toEqual(["Song", "next song"]);
    const locked = harness();
    locked.background();
    await locked.session.sync(snapshot());
    expect(locked.counts().starts).toBe(0);
    expect(locked.leases).toEqual([]);
  });

  test("unpairing during an in-flight native update ends the activity afterward", async () => {
    let finish!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let ended = false;
    const leases: boolean[] = [];
    const activity: ActivityHandle = {
      update: async () => { entered(); await waiting; },
      end: async () => { ended = true; },
    };
    const session = new ActivitySession({ recover: () => [], start: () => activity, foreground: () => true, keepAlive: async active => { leases.push(active); } });
    const updating = session.sync(snapshot());
    await started;
    const stopping = session.sync(null);
    finish();
    await Promise.all([updating, stopping]);
    expect(ended).toBe(true);
    expect(leases).toEqual([true, false]);
  });

  test("recovering an activity after relaunch updates it and removes duplicates", async () => {
    let duplicateEnded = false;
    const updated: string[] = [];
    const first: ActivityHandle = { update: async props => { updated.push(props.title); }, end: async () => {} };
    const duplicate: ActivityHandle = { update: async () => {}, end: async () => { duplicateEnded = true; } };
    const h = harness([first, duplicate]);
    await h.session.sync(snapshot("restored"));
    expect(duplicateEnded).toBe(true);
    expect(updated).toEqual(["restored"]);
    expect(h.counts().starts).toBe(0);
  });

  test("dismissing the activity releases the silent player and does not recreate it while locked", async () => {
    let active = true, foreground = true, starts = 0;
    const leases: boolean[] = [];
    const activity: ActivityHandle = { update: async () => {}, end: async () => {} };
    const session = new ActivitySession({
      recover: () => [], start: () => { starts++; return activity; },
      foreground: () => foreground, isActive: () => active,
      keepAlive: async value => { leases.push(value); },
    });
    await session.sync(snapshot());
    foreground = false;
    active = false;
    await session.sync(snapshot());
    await session.sync(snapshot("next"));
    expect(starts).toBe(1);
    expect(leases).toEqual([true, false]);
  });
});
