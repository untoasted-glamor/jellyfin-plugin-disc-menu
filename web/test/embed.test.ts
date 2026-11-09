// The player's side of the overlay: which messages count, the Back keys, and stopping before it answers Close.
import { describe, expect, it, vi } from "vitest";
import { CLOSE, CLOSE_REQUEST, CLOSED, embedInPlayer, embedMessage, isBackKey, isEmbedded } from "../src/embed.js";

const ORIGIN = "http://jf.test";
const parent = { postMessage: vi.fn() };

function msg(type: unknown, source: unknown = parent, origin = ORIGIN): MessageEvent {
  return { data: { type }, source, origin } as unknown as MessageEvent;
}

const key = (k: string, keyCode = 0, target: unknown = null) => ({ key: k, keyCode, target }) as unknown as KeyboardEvent;

describe("messages", () => {
  it("takes our types from the expected window on our origin only", () => {
    const from = parent as unknown as MessageEventSource;
    expect(embedMessage(msg(CLOSE), from, ORIGIN)).toBe(CLOSE);
    expect(embedMessage(msg(CLOSED), from, ORIGIN)).toBe(CLOSED);
    expect(embedMessage(msg(CLOSE_REQUEST), from, ORIGIN)).toBe(CLOSE_REQUEST);
    expect(embedMessage(msg(CLOSE, parent, "http://evil.test"), from, ORIGIN)).toBeNull();
    expect(embedMessage(msg(CLOSE, {}), from, ORIGIN)).toBeNull();
    expect(embedMessage(msg("other"), from, ORIGIN)).toBeNull();
    expect(embedMessage({ data: null, source: parent, origin: ORIGIN } as unknown as MessageEvent, from, ORIGIN)).toBeNull();
    expect(embedMessage(msg(CLOSE), null, ORIGIN)).toBeNull();
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
});

/** A framed window: its parent, our origin, and the message handlers it registers. */
function framed() {
  const handlers: ((e: MessageEvent) => void)[] = [];
  const posted: unknown[] = [];
  const top = { postMessage: (m: unknown, o: string) => posted.push([m, o]) };
  const win = {
    parent: top,
    location: { origin: ORIGIN },
    addEventListener: (t: string, h: (e: MessageEvent) => void) => t === "message" && handlers.push(h),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  } as unknown as Window;
  const send = (type: string, source: unknown = top) => handlers.forEach((h) => h(msg(type, source)));
  return { win, top, posted, send };
}

describe("the player in the overlay", () => {
  it("is embedded only with embed=1 inside a frame", () => {
    const { win } = framed();
    expect(isEmbedded(win, new URLSearchParams("embed=1"))).toBe(true);
    expect(isEmbedded(win, new URLSearchParams(""))).toBe(false);
    const top = { parent: null as unknown } as { parent: unknown };
    top.parent = top;
    expect(isEmbedded(top as unknown as Window, new URLSearchParams("embed=1"))).toBe(false);
  });

  it("stops, then answers Close", async () => {
    const { win, posted, send } = framed();
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((r) => (release = r)));
    embedInPlayer(win, stop);
    send(CLOSE);
    expect(stop).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(posted).toEqual([]);
    release();
    await vi.waitFor(() => expect(posted).toEqual([[{ type: CLOSED }, ORIGIN]]));
  });

  it("answers even when stopping hangs or fails", async () => {
    vi.useFakeTimers();
    const { win, posted, send } = framed();
    embedInPlayer(win, () => new Promise<void>(() => {}), 1500);
    send(CLOSE);
    await vi.advanceTimersByTimeAsync(1600);
    expect(posted).toEqual([[{ type: CLOSED }, ORIGIN]]);
    vi.useRealTimers();

    const other = framed();
    embedInPlayer(other.win, () => Promise.reject(new Error("offline")));
    other.send(CLOSE);
    await vi.waitFor(() => expect(other.posted).toEqual([[{ type: CLOSED }, ORIGIN]]));
  });

  it("ignores Close from anyone but its parent, and asks the parent to close on Back", () => {
    const { win, posted, send } = framed();
    const stop = vi.fn(() => Promise.resolve());
    const requestClose = embedInPlayer(win, stop);
    send(CLOSE, {});
    expect(stop).not.toHaveBeenCalled();
    requestClose();
    expect(posted).toEqual([[{ type: CLOSE_REQUEST }, ORIGIN]]);
  });
});
