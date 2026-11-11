// @vitest-environment happy-dom
// The page's Blu-ray side: what a hand-off sends (the disc's own default streams are left to Jellyfin, a play-all's
// queue goes with it), the skips, and the menu drawn as button pictures.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BdPage, BdHost, discDefaults, menuFiles } from "../src/bdpage";
import type { PlayHandoff } from "../src/embed";
import type { HdmvCell, HdmvPack } from "../src/hdmvvm";
import { mediaKey, type MediaItem, type PlayRequest } from "../src/media";
import { button, ep, goto, makePack, menu, page, playlist, playPl, row, setGpr, setStream } from "./hdmvbuild";

const ID = (n: number) => n.toString(16).padStart(32, "0");
/** A library item for a cell, with English and Japanese audio and the pack's two subtitle files. */
const item = (c: HdmvCell, n: number): [string, MediaItem] => [
  mediaKey(c),
  {
    id: ID(n),
    name: c.extra ?? `E${c.episode}`,
    mediaSourceId: ID(n),
    streams: [
      { Index: 1, Type: "Audio", Language: "jpn", IsExternal: false },
      { Index: 2, Type: "Audio", Language: "eng", IsExternal: false },
      { Index: 5, Type: "Subtitle", Language: "eng", IsExternal: true, FileName: `${c.file.replace(/\.mkv$/, "")}.eng.sup` },
      { Index: 6, Type: "Subtitle", Language: "eng", IsExternal: true, FileName: `${c.file.replace(/\.mkv$/, "")}.eng.2.sup` },
    ],
  },
];

/**
 * A disc shaped like an anime box set's: the main menu's Play (button 1) sets English audio and the signs track and plays all
 * three episodes; Setup (2) picks Japanese with full subtitles and plays them too; button 3 plays the trailer with
 * subtitles off; button 4 plays a missing extra. First play starts episode 1 by itself before the menu.
 */
function disc(o: { autoplay?: boolean } = {}): HdmvPack {
  const streams = {
    audio: [
      { n: 1, lang3: "eng", codec: "ac3", channels: 6 },
      { n: 2, lang3: "jpn", codec: "lpcm", channels: 2 },
    ],
    pg: [
      { n: 1, lang3: "eng", sidecar: ".eng.sup" },
      { n: 2, lang3: "eng", sidecar: ".eng.2.sup" },
    ],
    ig: [],
  };
  return makePack({
    top: 0,
    // The menu playlist loops (goto back to its play_pl), as a disc's movie object does.
    objects: { 0: [...(o.autoplay ? [playPl(9)] : []), playPl(5), goto(o.autoplay ? 1 : 0)] },
    playlists: {
      "00005": playlist({ menus: { "1": "m.ig1" }, background: { video: "bg.mp4", still: "bg.jpg" } }),
      "00008": playlist({ secs: [1400, 1400, 1400], streams }),
      "00009": playlist({ secs: [1400], streams }),
      "00021": playlist({ secs: [120], streams }),
      "00022": playlist({ secs: [60], streams }),
    },
    menus: {
      "m.ig1": menu([
        page(0, row([
          button(1, [setStream({ audio: 1, pg: 2, pgOn: true }), playPl(8)]),
          button(2, [setStream({ audio: 2, pg: 1, pgOn: true }), playPl(8)]),
          button(3, [setStream({ pg: 2 }), playPl(21)]),
          button(4, [playPl(22)]),
          button(5, [setGpr(1, 1)], { images: { normal: [], selected: [], activated: [] } }),
        ]), { default_selected: 1 }),
      ]),
    },
    media: {
      "00008": { 0: ep(1), 1400: ep(2), 2800: ep(3) },
      "00009": { 0: ep(1) },
      "00021": { 0: { extra: "trailers/Trailer.mkv", file: "Trailer.mkv", offset: 0, dur: 120 } },
      "00022": { 0: { extra: "extras/Gone.mkv", file: "Gone.mkv", offset: 0, dur: 60 } },
    },
  });
}

function host(pack: HdmvPack, o: { embedded?: boolean; missing?: string[]; wait?: boolean } = {}) {
  const cells = Object.values(pack.media).flatMap((m) => Object.values(m.cells));
  // Ids by the cell's place in the pack; extras/Gone.mkv is never in the library.
  const missing = [...(o.missing ?? []), "X:extras/Gone.mkv"];
  const items = new Map<string, MediaItem>();
  cells.forEach((c, i) => {
    const [k, it] = item(c, i + 1);
    if (!missing.includes(k) && !items.has(k)) items.set(k, it);
  });
  const stage = document.createElement("div");
  const menuLayer = document.createElement("div");
  stage.append(menuLayer);
  document.body.replaceChildren(stage);
  const sent: PlayHandoff[] = [];
  const held: PlayHandoff[] = [];
  const shown: PlayRequest[] = [];
  const events: string[] = [];
  const statuses: string[] = [];
  const h: BdHost = {
    doc: document,
    stage,
    menuLayer,
    embedded: o.embedded ?? true,
    packUrl: (f) => `/pack/${f}`,
    watchLoad: () => {},
    playVideo: () => {},
    status: (s) => statuses.push(s),
    event: (_l, s) => events.push(s),
    trace: () => {},
    items: () => items,
    waitFirst: () => o.wait ?? false,
    title: (c) => c.extra?.split("/").pop() ?? `S01E${String(c.episode).padStart(2, "0")}`,
    send: (p) => sent.push(p),
    hold: (p) => held.push(p),
    show: (r) => shown.push(r),
    stopShow: () => {},
    refresh: () => {},
  };
  return { h, sent, held, shown, events, statuses, menuLayer };
}

const key = (bd: BdPage, k: string) => {
  bd.key(k);
  vi.advanceTimersByTime(200);
};

beforeEach(() => {
  vi.useFakeTimers();
});

describe("the Blu-ray hand-off", () => {
  it("works out the disc's own default streams from its first menu's default button", () => {
    expect(discDefaults(disc())).toEqual({ audio: 1, subp: (0x80000000 | 2) >>> 0, subOn: true });
  });

  it("Play leaves the disc's default streams to Jellyfin and queues the rest of the play-all", () => {
    const pack = disc();
    const t = host(pack);
    const bd = new BdPage(pack, t.h);
    bd.start();
    key(bd, "Enter");
    expect(t.sent).toEqual([{ itemId: ID(1), mediaSourceId: ID(1), name: "E1", queue: [ID(2), ID(3)] }]);
  });

  it("streams the viewer changed in the menu go with it", () => {
    const pack = disc();
    const t = host(pack);
    const bd = new BdPage(pack, t.h);
    bd.start();
    key(bd, "ArrowRight");
    key(bd, "Enter");
    expect(t.sent[0]).toMatchObject({ itemId: ID(1), audioIndex: 1, subtitleIndex: 5 });
  });

  it("subtitles the disc turns off go as -1", () => {
    const pack = disc();
    const t = host(pack);
    const bd = new BdPage(pack, t.h);
    bd.start();
    key(bd, "ArrowRight");
    key(bd, "ArrowRight");
    key(bd, "Enter");
    expect(t.sent[0]).toMatchObject({ name: "trailers/Trailer.mkv", subtitleIndex: -1 });
    expect(t.sent[0].audioIndex).toBeUndefined();
  });

  it("a play-all goes on without what the library lacks, and says so", () => {
    const pack = disc();
    const t = host(pack, { missing: ["E2"] });
    const bd = new BdPage(pack, t.h);
    bd.start();
    key(bd, "Enter");
    expect(t.sent[0].queue).toEqual([ID(3)]);
    expect(t.events).toContain("The play-all goes on without S01E02: not in the library");
  });

  it("a title the library lacks is skipped and the disc goes on", () => {
    const pack = disc();
    const t = host(pack);
    const bd = new BdPage(pack, t.h);
    bd.start();
    for (let i = 0; i < 3; i++) key(bd, "ArrowRight");
    key(bd, "Enter");
    expect(t.statuses.at(-1)).toMatch(/Gone\.mkv is not in the library, skipped/);
    vi.advanceTimersByTime(600);
    expect(t.sent).toEqual([]);
    expect(bd.inMenu).toBe(true);
  });

  it("an episode the disc starts before any menu button is skipped, to get to the menu", () => {
    const pack = disc({ autoplay: true });
    const t = host(pack);
    const bd = new BdPage(pack, t.h);
    bd.start();
    expect(t.statuses.at(-1)).toMatch(/started S01E01 .* before any menu button was pressed: skipped/);
    vi.advanceTimersByTime(600);
    expect(bd.inMenu).toBe(true);
    expect(t.sent).toEqual([]);
  });

  it("with Wait before playing from menu, the hand-off is held", () => {
    const pack = disc();
    const t = host(pack, { wait: true });
    const bd = new BdPage(pack, t.h);
    bd.start();
    key(bd, "Enter");
    expect(t.sent).toEqual([]);
    expect(t.held).toHaveLength(1);
  });

  it("on the page opened by hand the stub shows each cell of a play-all, then the disc goes on", () => {
    const pack = disc();
    const t = host(pack, { embedded: false });
    const bd = new BdPage(pack, t.h);
    bd.start();
    key(bd, "Enter");
    expect(t.shown.map((r) => [r.title, r.label])).toEqual([["S01E01", "playlist 00008 from 0:00"]]);
    bd.showEnded();
    bd.showEnded();
    expect(t.shown.map((r) => r.label)).toEqual(["playlist 00008 from 0:00", "playlist 00008, 2 of 3", "playlist 00008, 3 of 3"]);
    bd.showEnded();
    // After the play-all the disc's object goes back to its menu.
    expect(bd.inMenu).toBe(true);
  });
});

describe("the Blu-ray menu", () => {
  it("draws each shown button's picture, the selected one in its selected state, and none for a button with none", () => {
    const pack = disc();
    const t = host(pack);
    const bd = new BdPage(pack, t.h);
    bd.start();
    const imgs = [...t.menuLayer.querySelectorAll<HTMLImageElement>(".igb")];
    expect(imgs.map((i) => [i.dataset.id, i.dataset.file, i.classList.contains("on")])).toEqual([
      ["1", "s1.png", true],
      ["2", "n2.png", false],
      ["3", "n3.png", false],
      ["4", "n4.png", false],
    ]);
    expect(imgs[1].style.left).toBe(`${((200 / 1920) * 100).toFixed(3)}%`);
    key(bd, "ArrowRight");
    const again = [...t.menuLayer.querySelectorAll<HTMLImageElement>(".igb")];
    expect(again[0]).toBe(imgs[0]); // the same pictures, their state changed
    expect(again.map((i) => i.dataset.file)).toEqual(["n1.png", "s2.png", "n3.png", "n4.png"]);
    expect(t.menuLayer.querySelector("video")?.getAttribute("src")).toBe("/pack/bg.mp4");
  });

  it("lists every picture the menus use, to warm the cache", () => {
    expect(menuFiles(disc()).sort()).toEqual(
      ["bg.jpg", "n1.png", "n2.png", "n3.png", "n4.png", "s1.png", "s2.png", "s3.png", "s4.png"].sort(),
    );
  });

  it("the remote's Menu key goes to the top menu", () => {
    const pack = disc();
    const t = host(pack, { embedded: false });
    const bd = new BdPage(pack, t.h);
    bd.start();
    key(bd, "Enter");
    expect(bd.inMenu).toBe(false);
    bd.topMenu();
    expect(bd.inMenu).toBe(true);
  });
});
