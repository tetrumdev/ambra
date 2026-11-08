import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AlbumActions } from "../src/components/AlbumActions";
import type { EntityAction } from "../src/components/EntityView";
import type { Track } from "../src/types/music";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  globalThis.fetch = (() => Promise.resolve(Response.json({ tidal: true, qobuz: true, spotify: true }))) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; dom.happyDOM.abort(); });

const song = (id: string) => ({ globalId: `qobuz:${id}`, provider: "qobuz", providerTrackId: id }) as Track;

test("the album menu queues, plays next and saves the whole album", async () => {
  const tracks = [song("1"), song("2"), song("3")];
  const actions: [EntityAction, string[]][] = [];
  const saved: string[][] = [];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AlbumActions title="Album" tracks={tracks} savedTrackIds={new Set([tracks[0].globalId])}
    onAction={(action, list) => actions.push([action, list.map(track => track.globalId)])}
    onAddTracks={list => saved.push(list.map(track => track.globalId))} />));
  const choose = async (label: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>(".libraryMoreBtn")!.click());
    const item = [...document.querySelectorAll<HTMLButtonElement>(".menuItem")].find(button => button.textContent?.includes(label));
    expect(item, label).toBeDefined();
    await act(async () => item!.click());
  };
  await choose("Add to Queue");
  await choose("Play Next");
  await choose("Add to Library");
  const ids = tracks.map(track => track.globalId);
  expect(actions).toEqual([["queue", ids], ["nextAll", ids]]);
  expect(saved).toEqual([ids.slice(1)]);
  await act(async () => root.unmount());
});

test("the album menu adds the whole album to a playlist", async () => {
  const tracks = [song("1"), song("2")];
  const added: [string, string[]][] = [];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const playlistOptions = {
    playlists: [{ id: "mix", name: "Mix", trackIds: [] }],
    onAdd: () => false, onCreate: () => false, onCreateWithTracks: () => false,
    onAddTracks: (id: string, list: Track[]) => { added.push([id, list.map(track => track.globalId)]); return true; },
  };
  await act(async () => root.render(<AlbumActions title="Album" tracks={tracks} savedTrackIds={new Set()}
    onAction={() => {}} onAddTracks={() => {}} playlistOptions={playlistOptions} />));
  await act(async () => host.querySelector<HTMLButtonElement>(".libraryMoreBtn")!.click());
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".menuItem")].find(button => button.textContent?.includes(label))!;
  await act(async () => menuItem("Add to Playlist").click());
  await act(async () => menuItem("Mix").click());
  expect(added).toEqual([["mix", tracks.map(track => track.globalId)]]);
  await act(async () => root.unmount());
});
