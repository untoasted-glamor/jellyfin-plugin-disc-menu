// The walk back end (P13): every reachable page and button, on packs built at test time and on the Sintel fixture.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TICKS } from "../src/hdmvvm";
import { walk, walkPack } from "../src/walk";
import { button, makePack, menu, page, playPl, playPlMk, playlist, setButtonPage, withMenu } from "./hdmvbuild";
import { loadPack } from "./helpers";

const marked = () =>
  playlist({
    secs: [30, 30],
    marks: [
      { type: "entry", item: 0, time: 0, at: 0 },
      { type: "entry", item: 1, time: 0, at: 30 * TICKS },
    ],
  });

function bdPack() {
  return makePack({
    objects: { 0: [playPl(1), playPl(5)], 1: [playPl(5)] },
    playlists: { "00001": playlist({ secs: [12] }), "00005": withMenu(), "00010": marked(), "00011": playlist({ secs: [90] }) },
    menus: {
      "m.ig1": menu([
        page(0, [
          button(1, [playPlMk(10, 1)]),
          button(2, [setButtonPage(3, 1)]),
          button(9, [], { images: { normal: [], selected: [], activated: [] } }),
        ]),
        page(1, [button(3, [playPl(11)]), button(4, [setButtonPage(1, 0)])]),
      ]),
    },
  });
}

describe("Blu-ray walk", () => {
  it("gives every playlist that shows no menu a stand-in cell, and leaves the menu's playlist alone", () => {
    const media = walkPack(bdPack()).media;
    expect(Object.keys(media).sort()).toEqual(["00001", "00010", "00011"]);
    expect(media["00010"].cells["0"].dur).toBe(61);
  });

  it("records first play's hand-offs, then walks every page and button reachable from the first menu", () => {
    const r = walk(bdPack());
    expect(r.disc).toBe("bd");
    expect(r.first_play).toEqual([
      { kind: "plays", playlist: "00001", start: 0, mark: null, seconds: 0 },
      { kind: "menu", at: "m.ig1 p0" },
    ]);
    expect(r.pages.map((p) => [p.at, p.path, p.language])).toEqual([
      ["m.ig1 p0", [], "eng"],
      ["m.ig1 p1", [2], "eng"],
    ]);
    const [p0, p1] = r.pages;
    expect(p0.buttons.map((b) => [b.id, b.image, b.outcome])).toEqual([
      [1, "n1.png", { kind: "plays", playlist: "00010", start: 30 * TICKS, mark: 1, seconds: 30 }],
      [2, "n2.png", { kind: "menu", at: "m.ig1 p1" }],
      [9, null, { kind: "menu", at: "m.ig1 p0" }],
    ]);
    expect(p1.buttons.map((b) => [b.id, b.outcome.kind])).toEqual([
      [3, "plays"],
      [4, "menu"],
    ]);
    expect(r.truncated).toBe(false);
  });

  it("walks once per language, counting a page with the same buttons once", () => {
    const r = walk(bdPack(), { languages: ["eng", "jpn"] });
    expect(r.pages).toHaveLength(2);
  });

  it("stops at the page limit and says so", () => {
    const r = walk(bdPack(), { maxPages: 1 });
    expect(r.pages).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("refuses a pack it doesn't know", () => {
    expect(() => walk({ schema: "x" } as never)).toThrow(/unknown pack schema/);
  });
});

describe("DVD walk", () => {
  it("lists what every Sintel menu button does, titles by number and chapter", () => {
    const r = walk(loadPack("sintel"));
    expect(r.disc).toBe("dvd");
    expect(r.pages.length).toBeGreaterThan(0);
    const plays = r.pages.flatMap((p) => p.buttons).filter((b) => b.outcome.kind === "plays_title");
    expect(plays.length).toBeGreaterThan(0);
    for (const b of plays) {
      if (b.outcome.kind !== "plays_title") continue;
      expect(b.outcome.title).toBeGreaterThan(0);
      expect(b.outcome.chapter).toBeGreaterThan(0);
      expect(b.w).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!existsSync(new URL("../walk-dist/walk.mjs", import.meta.url)))("the Node build", () => {
  it("walks a pack file and prints one JSON document", () => {
    const dir = mkdtempSync(join(tmpdir(), "walk-"));
    writeFileSync(join(dir, "menu.json"), JSON.stringify(bdPack()));
    const out = execFileSync("node", [new URL("../walk-dist/walk.mjs", import.meta.url).pathname, join(dir, "menu.json"), "--lang", "eng"], {
      encoding: "utf8",
    });
    const r = JSON.parse(out);
    expect(r.schema).toBe("walk-1");
    expect(r.pages).toHaveLength(2);
    expect(typeof r.version).toBe("string");
  });
});
