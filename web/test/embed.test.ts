// The messages between the overlay and the player: which ones count, the hand-off's checks, and the remote's keys.
import { describe, expect, it } from "vitest";
import {
  CHECK, CHECKED, checkedMessage, CLOSE_REQUEST, embedInPlayer, embedMessage, isBackKey, isEmbedded, isInfoKey, parsePlay, PLAY,
} from "../src/embed.js";

const ORIGIN = "http://jf.test";
const ITEM = "41f6b840b8c91fba90ca5906e7544c90";
const parent = { postMessage: () => {} };

function msg(data: unknown, source: unknown = parent, origin = ORIGIN): MessageEvent {
  return { data, source, origin } as unknown as MessageEvent;
}

const key = (k: string, keyCode = 0, target: unknown = null) => ({ key: k, keyCode, target }) as unknown as KeyboardEvent;

describe("messages", () => {
  const from = parent as unknown as MessageEventSource;

  it("takes our types from the expected window on our origin only", () => {
    expect(embedMessage(msg({ type: CLOSE_REQUEST }), from, ORIGIN)).toEqual({ type: CLOSE_REQUEST });
    const play = { itemId: ITEM, name: "S01E01" };
    expect(embedMessage(msg({ type: PLAY, play }), from, ORIGIN)).toEqual({ type: PLAY, play });
    expect(embedMessage(msg({ type: CLOSE_REQUEST }, parent, "http://evil.test"), from, ORIGIN)).toBeNull();
    expect(embedMessage(msg({ type: CLOSE_REQUEST }, {}), from, ORIGIN)).toBeNull();
    expect(embedMessage(msg({ type: "discmenu:close" }), from, ORIGIN)).toBeNull();
    expect(embedMessage(msg(null), from, ORIGIN)).toBeNull();
    expect(embedMessage(msg({ type: CLOSE_REQUEST }), null, ORIGIN)).toBeNull();
  });

  it("takes a check of a held hand-off, with the same checks as a hand-off", () => {
    const play = { itemId: ITEM, name: "S01E01" };
    expect(embedMessage(msg({ type: CHECK, play }), from, ORIGIN)).toEqual({ type: CHECK, play });
    expect(embedMessage(msg({ type: CHECK, play: { ...play, url: "x" } }), from, ORIGIN)).toBeNull();
  });

  it("player side: takes the overlay's answer from its parent on our origin only, and well formed", () => {
    const ok = { type: CHECKED, result: { session: "c0ffee00c0ffee00c0ffee00c0ffee00", detail: "Would send POST ..." } };
    expect(checkedMessage(msg(ok), from, ORIGIN)).toEqual(ok.result);
    expect(checkedMessage(msg({ type: CHECKED, result: { session: null, detail: "none" } }), from, ORIGIN)).toEqual({ session: null, detail: "none" });
    expect(checkedMessage(msg(ok, parent, "http://evil.test"), from, ORIGIN)).toBeNull();
    expect(checkedMessage(msg(ok, {}), from, ORIGIN)).toBeNull();
    expect(checkedMessage(msg({ type: CHECKED, result: { session: "<b>", detail: "x" } }), from, ORIGIN)).toBeNull();
    expect(checkedMessage(msg({ type: CHECKED, result: { session: null, detail: "x".repeat(2001) } }), from, ORIGIN)).toBeNull();
    expect(checkedMessage(msg({ type: CHECKED, result: { session: null, detail: "x", extra: 1 } }), from, ORIGIN)).toBeNull();
    expect(checkedMessage(msg({ type: PLAY, result: ok.result }), from, ORIGIN)).toBeNull();
  });

  it("drops a hand-off whose data doesn't pass the checks", () => {
    expect(embedMessage(msg({ type: PLAY, play: { itemId: "x", name: "n" } }), from, ORIGIN)).toBeNull();
    expect(embedMessage(msg({ type: PLAY }), from, ORIGIN)).toBeNull();
  });
});

describe("the hand-off's checks", () => {
  const ok = { itemId: ITEM, name: "Sintel" };

  it("takes the smallest and the largest valid hand-off", () => {
    expect(parsePlay(ok)).toEqual(ok);
    const full = {
      itemId: "2f3a6b0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      mediaSourceId: ITEM.toUpperCase(),
      startTicks: Number.MAX_SAFE_INTEGER,
      audioIndex: 0,
      subtitleIndex: -1,
      name: "n".repeat(200),
      queue: Array.from({ length: 100 }, () => ITEM),
    };
    expect(parsePlay(full)).toEqual(full);
    expect(parsePlay({ ...ok, queue: [] })).toEqual(ok);
    expect(parsePlay({ ...ok, startTicks: 0 })).toEqual({ ...ok, startTicks: 0 });
  });

  it.each([
    ["no item", { name: "n" }],
    ["an item that isn't an id", { ...ok, itemId: "<img src=x onerror=alert(1)>" }],
    ["a media source that isn't an id", { ...ok, mediaSourceId: "../x" }],
    ["a float position", { ...ok, startTicks: 1.5 }],
    ["NaN", { ...ok, startTicks: NaN }],
    ["a negative position", { ...ok, startTicks: -1 }],
    ["a position past safe integers", { ...ok, startTicks: 2 ** 53 }],
    ["an index of -2", { ...ok, audioIndex: -2 }],
    ["a string index", { ...ok, subtitleIndex: "3" }],
    ["an extra key", { ...ok, url: "https://example.test/" }],
    ["no name", { itemId: ITEM }],
    ["a long name", { ...ok, name: "n".repeat(201) }],
    ["a queue that isn't a list", { ...ok, queue: ITEM }],
    ["a queue with something that isn't an id", { ...ok, queue: [ITEM, "../x"] }],
    ["a queue past 100 items", { ...ok, queue: Array.from({ length: 101 }, () => ITEM) }],
    ["an array", [ok]],
    ["a string", "play"],
  ])("refuses %s", (_what, data) => {
    expect(parsePlay(data)).toBeNull();
  });
});

describe("keys", () => {
  it("counts the remotes' Back keys and Backspace, not Escape", () => {
    expect(isBackKey(key("BrowserBack"))).toBe(true);
    expect(isBackKey(key("GoBack"))).toBe(true);
    expect(isBackKey(key("Unidentified", 461))).toBe(true);
    expect(isBackKey(key("Unidentified", 10009))).toBe(true);
    expect(isBackKey(key("Backspace"))).toBe(true);
    expect(isBackKey(key("Escape"))).toBe(false);
    expect(isBackKey(key("m"))).toBe(false);
  });

  it("leaves Backspace to a form field", () => {
    const field = { closest: (q: string) => (q.includes("input") ? {} : null) };
    expect(isBackKey(key("Backspace", 8, field))).toBe(false);
  });

  it("knows the remote's Info key", () => {
    expect(isInfoKey(key("Info"))).toBe(true);
    expect(isInfoKey(key("Unidentified", 457))).toBe(true);
    expect(isInfoKey(key("i", 73))).toBe(false);
    expect(isInfoKey(key("ArrowUp", 38))).toBe(false);
  });
});

describe("the player in the overlay", () => {
  function framed() {
    const posted: unknown[] = [];
    const top = { postMessage: (m: unknown, o: string) => posted.push([m, o]) };
    const win = { parent: top, location: { origin: ORIGIN } } as unknown as Window;
    return { win, posted };
  }

  it("is embedded only with embed=1 inside a frame", () => {
    const { win } = framed();
    expect(isEmbedded(win, new URLSearchParams("embed=1"))).toBe(true);
    expect(isEmbedded(win, new URLSearchParams(""))).toBe(false);
    const top = { parent: null as unknown } as { parent: unknown };
    top.parent = top;
    expect(isEmbedded(top as unknown as Window, new URLSearchParams("embed=1"))).toBe(false);
  });

  it("asks its parent, on our origin, to close or to hand a title over", () => {
    const { win, posted } = framed();
    const o = embedInPlayer(win);
    o.requestClose();
    o.handOff({ itemId: ITEM, name: "S01E01", startTicks: 10 });
    o.check({ itemId: ITEM, name: "S01E01" });
    expect(posted).toEqual([
      [{ type: CLOSE_REQUEST }, ORIGIN],
      [{ type: PLAY, play: { itemId: ITEM, name: "S01E01", startTicks: 10 } }, ORIGIN],
      [{ type: CHECK, play: { itemId: ITEM, name: "S01E01" } }, ORIGIN],
    ]);
  });
});
