// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://jf.test/jellyfin/web/index.html"}
// The Disc menu button in the web client: where it goes, when it shows, and the overlay it opens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_REQUEST, PLAY, PlayHandoff } from "../src/embed.js";
import {
  BUTTON_CLASS, DiscMenuButton, detailsItemId, FullScreen, Handoff, OVERLAY_ID, playerUrl, serverRootFrom,
} from "../src/inject.js";

const ROOT = "http://jf.test/jellyfin/";
const SERVER_ID = "efbb39fc71254bada62c5341e77e67df";
const SERIES = "41f6b840b8c91fba90ca5906e7544c90";
const OTHER = "0123456789abcdef0123456789abcdef";

describe("addresses", () => {
  it("finds the server root from the script's own address, base URL included", () => {
    expect(serverRootFrom("http://jf.test/jellyfin/DiscMenu/Inject/button.js", "http://jf.test")).toBe(ROOT);
    expect(serverRootFrom("http://jf.test/DiscMenu/Inject/button.js", "http://jf.test")).toBe("http://jf.test/");
  });

  it("refuses a script from another origin", () => {
    expect(serverRootFrom("http://evil.test/DiscMenu/Inject/button.js", "http://jf.test")).toBeNull();
    expect(serverRootFrom("not a url", "http://jf.test")).toBeNull();
  });

  it("reads the item id of a details page only", () => {
    expect(detailsItemId(`#/details?id=${SERIES}&serverId=${SERVER_ID}`)).toBe(SERIES);
    expect(detailsItemId(`#!/details?id=${SERIES}`)).toBe(SERIES);
    expect(detailsItemId("#/details?id=2f3a6b0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("2f3a6b0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(detailsItemId(`#/home?id=${SERIES}`)).toBeNull();
    expect(detailsItemId("#/details?id=")).toBeNull();
  });

  it("refuses an id that isn't a Jellyfin id", () => {
    expect(detailsItemId("#/details?id=<img src=x onerror=alert(1)>")).toBeNull();
    expect(detailsItemId(`#/details?id=${SERIES}/../../x`)).toBeNull();
  });

  it("builds the player's address under the server root", () => {
    expect(playerUrl(ROOT, SERIES)).toBe(`${ROOT}DiscMenu/Player/?item=${SERIES}&embed=1`);
  });
});

/** A details page as the web client draws it: Play, a hidden Replay, and the played-state button naming the item. */
function detailsPage(type = "Series", item = SERIES): HTMLElement {
  const page = document.createElement("div");
  page.className = "page libraryPage itemDetailPage";
  const box = document.createElement("div");
  box.className = "mainDetailButtons focuscontainer-x";
  for (const cls of ["btnPlay", "btnReplay hide", "btnShuffle"]) {
    const b = document.createElement("button");
    b.className = `button-flat ${cls} detailButton emby-button`;
    box.append(b);
  }
  const state = document.createElement("button");
  state.className = "button-flat btnPlaystate detailButton emby-button";
  state.dataset.id = item;
  state.dataset.type = type;
  box.append(state);
  page.append(box);
  document.body.append(page);
  return page;
}

interface Server {
  discs: Record<string, unknown[]>;
  serverId: string;
  calls: string[];
}

function server(over: Partial<Server> = {}): Server & { fetcher: typeof fetch } {
  const s: Server = { discs: { [SERIES]: [{ Id: "d1", Name: "Disc 1", Type: "dvd" }] }, serverId: SERVER_ID, calls: [], ...over };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    s.calls.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
    if (url === `${ROOT}System/Info/Public`) return new Response(JSON.stringify({ Id: s.serverId }));
    const m = /DiscMenu\/Items\/([^/]+)\/Discs$/.exec(url);
    if (m && s.discs[m[1]]) return new Response(JSON.stringify(s.discs[m[1]]));
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { ...s, get calls() { return s.calls; }, fetcher };
}

const DEVICE = "TW96aWxsYS81LjB8MTczMTA";
const USER = "6f1b2c3d4e5f60718293a4b5c6d7e8f9";
const api = {
  accessToken: () => "tok123",
  serverId: () => SERVER_ID,
  deviceId: () => DEVICE,
  appName: () => "Jellyfin Web",
  getCurrentUserId: () => USER,
};

function go(hash: string): void {
  window.location.hash = hash;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.overflow = "";
  go("");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the button", () => {
  it("goes right after Play on a series with a pack, with no markup from data", async () => {
    const page = detailsPage();
    const srv = server();
    go(`#/details?id=${SERIES}`);
    await new DiscMenuButton(window, ROOT, () => api, srv.fetcher).refresh();
    const buttons = [...page.querySelectorAll(".mainDetailButtons > button")].map((b) => b.className.split(" ")[1]);
    expect(buttons.slice(0, 2)).toEqual(["btnPlay", "detailButton"]);
    const b = page.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`)!;
    expect(b.title).toBe("Disc menu");
    expect(b.dataset.item).toBe(SERIES);
    expect(b.textContent).toBe("");
    expect(srv.calls.some((c) => c.includes(`DiscMenu/Items/${SERIES}/Discs`) && c.includes('MediaBrowser Token=\\"tok123\\"'))).toBe(true);
  });

  it("doesn't show without a pack, on another type, or signed in to another server", async () => {
    const cases: [string, Partial<Server>][] = [
      ["Series", { discs: { [SERIES]: [] } }],
      ["Episode", {}],
      ["Series", { serverId: "ffffffffffffffffffffffffffffffff" }],
    ];
    for (const [type, over] of cases) {
      document.body.replaceChildren();
      const page = detailsPage(type);
      go(`#/details?id=${SERIES}`);
      await new DiscMenuButton(window, ROOT, () => api, server(over).fetcher).refresh();
      expect(page.querySelector(`.${BUTTON_CLASS}`), `${type} ${JSON.stringify(over)}`).toBeNull();
    }
  });

  it("waits while the page still shows the last item, and doesn't ask for an episode", async () => {
    const srv = server();
    const button = new DiscMenuButton(window, ROOT, () => api, srv.fetcher);
    const page = detailsPage("Movie", OTHER);
    go(`#/details?id=${SERIES}`);
    await button.refresh();
    expect(page.querySelector(`.${BUTTON_CLASS}`)).toBeNull();
    document.body.replaceChildren();
    detailsPage("Episode");
    await button.refresh();
    document.body.replaceChildren();
    const unnamed = detailsPage();
    unnamed.querySelector(".btnPlaystate")!.removeAttribute("data-id");
    await button.refresh();
    expect(srv.calls.filter((c) => c.includes("/Discs"))).toEqual([]);
  });

  it("asks once a minute per item", async () => {
    detailsPage();
    const srv = server();
    const button = new DiscMenuButton(window, ROOT, () => api, srv.fetcher);
    go(`#/details?id=${SERIES}`);
    await button.refresh();
    document.querySelector(`.${BUTTON_CLASS}`)!.remove();
    await button.refresh();
    expect(srv.calls.filter((c) => c.includes("/Discs")).length).toBe(1);
    expect(document.querySelectorAll(`.${BUTTON_CLASS}`).length).toBe(1);
  });

  it("only on the visible details page, and leaves when the viewer moves to another item", async () => {
    const hidden = detailsPage();
    hidden.classList.add("hide");
    const shown = detailsPage();
    const srv = server();
    const button = new DiscMenuButton(window, ROOT, () => api, srv.fetcher);
    go(`#/details?id=${SERIES}`);
    await button.refresh();
    expect(hidden.querySelector(`.${BUTTON_CLASS}`)).toBeNull();
    expect(shown.querySelector(`.${BUTTON_CLASS}`)).not.toBeNull();
    go(`#/details?id=${OTHER}`);
    await button.refresh();
    expect(document.querySelector(`.${BUTTON_CLASS}`)).toBeNull();
  });
});

describe("the overlay", () => {
  // happy-dom loads no frame pages and prints a line for each frame it skips; that is expected here.
  afterEach(() => vi.restoreAllMocks());

  async function opened(fetcher = server().fetcher) {
    detailsPage();
    go(`#/details?id=${SERIES}`);
    // Let that navigation's hashchange go by: the overlay closes on any navigation.
    await new Promise((r) => setTimeout(r, 0));
    const button = new DiscMenuButton(window, ROOT, () => api, fetcher);
    await button.refresh();
    const push = vi.spyOn(window.history, "pushState");
    document.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`)!.click();
    const overlay = button.current!;
    // The frame loads no page here; stand in for the player's window.
    const player = { postMessage: vi.fn(), focus: () => {} };
    Object.defineProperty(overlay.frame, "contentWindow", { value: player });
    return { button, overlay, push, player };
  }

  /** A message from the player in the overlay's frame. */
  function fromPlayer(frame: HTMLIFrameElement, data: unknown, origin = window.location.origin): void {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: frame.contentWindow }));
  }

  /** history.back() that fires popstate, as a browser does once it went back. */
  function realBack() {
    return vi.spyOn(window.history, "back").mockImplementation(() => {
      setTimeout(() => window.dispatchEvent(new PopStateEvent("popstate", { state: null })), 0);
    });
  }

  it("opens the player full screen in a same-origin frame, with a history entry of its own", async () => {
    const { overlay, push } = await opened();
    const el = document.getElementById(OVERLAY_ID)!;
    expect(el).toBe(overlay.el);
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.style.position).toBe("fixed");
    expect(overlay.frame.getAttribute("src")).toBe(`${ROOT}DiscMenu/Player/?item=${SERIES}&embed=1`);
    expect(new URL(overlay.frame.src).origin).toBe(window.location.origin);
    expect(push).toHaveBeenCalledWith({ discMenu: true }, "");
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(el.querySelector("button")).toBeNull(); // the player has the bar, Close included
  });

  it("closes at once on the player's Close, back past its entry, with the focus on the button", async () => {
    const { button, overlay } = await opened();
    const back = realBack();
    fromPlayer(overlay.frame, { type: CLOSE_REQUEST });
    await overlay.close();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(button.current).toBeNull();
    expect(back).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(document.querySelector(`.${BUTTON_CLASS}`));
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("ignores messages from elsewhere", async () => {
    const { overlay } = await opened();
    fromPlayer(overlay.frame, { type: CLOSE_REQUEST }, "http://evil.test");
    window.dispatchEvent(new MessageEvent("message", { data: { type: CLOSE_REQUEST }, origin: window.location.origin, source: window }));
    fromPlayer(overlay.frame, { type: PLAY, play: { itemId: "not-an-id", name: "x" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
  });

  it("Back closes it without going back a second time", async () => {
    const { overlay } = await opened();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await overlay.close();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(back).not.toHaveBeenCalled();
  });

  it("Escape or Back on the overlay itself (before the frame has the focus) closes it", async () => {
    const { overlay } = await opened();
    realBack();
    overlay.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await overlay.close();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  it("opens one overlay at a time", async () => {
    const { button, overlay } = await opened();
    document.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`)!.click();
    expect(button.current).toBe(overlay);
    expect(document.querySelectorAll(`#${OVERLAY_ID}`).length).toBe(1);
  });

  it("a hand-off removes the overlay, waits for its Back, then sends the Play command", async () => {
    const order: string[] = [];
    const srv = sessionServer({ onPlay: () => order.push("play") });
    const { overlay } = await opened(srv.fetcher);
    vi.spyOn(window.history, "back").mockImplementation(() => {
      order.push("back");
      setTimeout(() => {
        order.push("popstate");
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      }, 0);
    });
    fromPlayer(overlay.frame, { type: PLAY, play: { itemId: EPISODE, name: "S01E01" } });
    fromPlayer(overlay.frame, { type: PLAY, play: { itemId: EPISODE, name: "again" } });
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    await vi.waitFor(() => expect(order).toEqual(["back", "popstate", "play"]));
    expect(srv.plays.length).toBe(1);
  });
});

const EPISODE = "aaaabbbbccccddddeeeeffff00001111";
const SESSION = "c0ffee00c0ffee00c0ffee00c0ffee00";

interface SessionServer {
  fetcher: typeof fetch;
  plays: URL[];
  calls: string[];
}

/** The server's Sessions routes: this web client's session among others, and what a Play command does to it. */
function sessionServer(o: {
  sessions?: object[];
  playStatus?: number;
  /** What the session plays after the Play command: the item (default), nothing, or another id. */
  playing?: string | null;
  before?: string | null;
  onPlay?: () => void;
} = {}): SessionServer {
  const plays: URL[] = [];
  const calls: string[] = [];
  let now: string | null = o.before ?? null;
  const own = () => ({ Id: SESSION, DeviceId: DEVICE, Client: "Jellyfin Web", UserId: USER, NowPlayingItem: now ? { Id: now } : null });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/System/Info/Public")) return new Response(JSON.stringify({ Id: SERVER_ID }));
    if (/DiscMenu\/Items\/[^/]+\/Discs$/.test(url.pathname)) return new Response(JSON.stringify([{ Id: "d1", Name: "Disc 1", Type: "dvd" }]));
    if (url.pathname.endsWith("/Sessions") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(o.sessions ?? [own()]));
    }
    const m = /\/Sessions\/([^/]+)\/Playing$/.exec(url.pathname);
    if (m && init?.method === "POST") {
      plays.push(url);
      o.onPlay?.();
      const status = o.playStatus ?? 204;
      if (status === 204) now = o.playing === undefined ? url.searchParams.get("itemIds") : o.playing;
      return new Response(null, { status });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, plays, calls };
}

describe("the hand-off", () => {
  const FAST = { pollMs: 5, confirmMs: 40 };
  const h: PlayHandoff = { itemId: EPISODE, name: "S01E03", mediaSourceId: SERIES, startTicks: 3_499_700_000, audioIndex: 2, subtitleIndex: -1 };
  const run = (srv: SessionServer, hand: PlayHandoff = h) =>
    new Handoff(window, ROOT, api, srv.fetcher, FAST, () => {}).run(hand, window.location.hash);

  beforeEach(() => go(`#/details?id=${SERIES}`));

  it("sends one Play command to this web client's own session, with what the menu picked", async () => {
    const srv = sessionServer();
    expect(await run(srv)).toBe("playing");
    expect(srv.calls[0]).toBe(`GET /jellyfin/Sessions?deviceId=${DEVICE}`);
    const q = srv.plays[0];
    expect(q.pathname).toBe(`/jellyfin/Sessions/${SESSION}/Playing`);
    expect(Object.fromEntries(q.searchParams)).toEqual({
      playCommand: "PlayNow", itemIds: EPISODE, startPositionTicks: "3499700000", mediaSourceId: SERIES,
      audioStreamIndex: "2", subtitleStreamIndex: "-1",
    });
    expect(window.location.hash).toBe(`#/details?id=${SERIES}`);
  });

  it("leaves out what the menu didn't pick", async () => {
    const srv = sessionServer();
    await run(srv, { itemId: EPISODE, name: "S01E01" });
    expect(Object.fromEntries(srv.plays[0].searchParams)).toEqual({ playCommand: "PlayNow", itemIds: EPISODE });
  });

  it("doesn't use a session of the same device for another user, or another client", async () => {
    const others = [
      { Id: "s-user", DeviceId: DEVICE, Client: "Jellyfin Web", UserId: "ffffffffffffffffffffffffffffffff" },
      { Id: "s-client", DeviceId: DEVICE, Client: "Disc Menu", UserId: USER },
    ];
    const srv = sessionServer({ sessions: others });
    expect(await run(srv)).toBe("fallback");
    expect(srv.plays).toEqual([]);
    expect(window.location.hash).toBe(`#/details?id=${EPISODE}`);
  });

  it("decodes the web client's app name and device id, which its ApiClient keeps URI-encoded", async () => {
    const encoded = { ...api, deviceId: () => encodeURIComponent(`${DEVICE}==`), appName: () => encodeURIComponent("Jellyfin Web") };
    const srv = sessionServer({ sessions: [{ Id: SESSION, DeviceId: `${DEVICE}==`, Client: "Jellyfin Web", UserId: USER }], playing: null });
    await new Handoff(window, ROOT, encoded, srv.fetcher, FAST, () => {}).run(h, window.location.hash);
    expect(srv.calls[0]).toBe(`GET /jellyfin/Sessions?deviceId=${encodeURIComponent(`${DEVICE}==`)}`);
    expect(srv.plays.length).toBe(1);
  });

  it("matches the user id written with or without dashes", async () => {
    const dashed = USER.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5").toUpperCase();
    const srv = sessionServer({ sessions: [{ Id: SESSION, DeviceId: DEVICE.toLowerCase(), Client: "Jellyfin Web", UserId: dashed }] });
    await run(srv);
    expect(srv.plays.length).toBe(1);
  });

  it("opens the title's details page when the server refuses the command", async () => {
    const srv = sessionServer({ playStatus: 403 });
    expect(await run(srv)).toBe("fallback");
    expect(window.location.hash).toBe(`#/details?id=${EPISODE}`);
  });

  it("opens the details page when the 204 led to nothing playing (no live connection)", async () => {
    const srv = sessionServer({ playing: null });
    expect(await run(srv)).toBe("fallback");
    expect(window.location.hash).toBe(`#/details?id=${EPISODE}`);
  });

  it("counts anything new playing (an intro first), but not what already played", async () => {
    expect(await run(sessionServer({ playing: "1234567890abcdef1234567890abcdef" }))).toBe("playing");
    go(`#/details?id=${SERIES}`);
    const same = "99999999999999999999999999999999";
    expect(await run(sessionServer({ before: same, playing: same }))).not.toBe("playing");
  });

  it("doesn't open the details page once the web client has moved on (its player starting late)", async () => {
    const srv = sessionServer({ playing: null, onPlay: () => setTimeout(() => go("#/video"), 10) });
    expect(await run(srv)).toBe("moved");
    expect(window.location.hash).toBe("#/video");
  });

  it("falls back when the session list can't be read", async () => {
    const broken = (async () => new Response("", { status: 500 })) as typeof fetch;
    const result = await new Handoff(window, ROOT, api, broken, FAST, () => {}).run(h, window.location.hash);
    expect(result).toBe("fallback");
    expect(window.location.hash).toBe(`#/details?id=${EPISODE}`);
  });
});

describe("full screen", () => {
  afterEach(() => {
    delete (window as unknown as { NativeShell?: unknown }).NativeShell;
    vi.restoreAllMocks();
  });

  it("uses the Android app's NativeShell when there is one, and undoes it on close", () => {
    const shell = { enableFullscreen: vi.fn(), disableFullscreen: vi.fn() };
    (window as unknown as { NativeShell: unknown }).NativeShell = shell;
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", { value: request, configurable: true });
    const fs = new FullScreen(window);
    fs.enter();
    expect(shell.enableFullscreen).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    fs.exit();
    expect(shell.disableFullscreen).toHaveBeenCalledOnce();
  });

  it("in the app, leaves full screen to the native player after a hand-off", () => {
    const shell = { enableFullscreen: vi.fn(), disableFullscreen: vi.fn() };
    (window as unknown as { NativeShell: unknown }).NativeShell = shell;
    const fs = new FullScreen(window);
    fs.enter();
    fs.exitAfterVideo();
    fs.exit();
    expect(shell.disableFullscreen).not.toHaveBeenCalled();
  });

  it("in a browser, puts the whole document full screen and leaves it only if it entered it", async () => {
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", { value: request, configurable: true });
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
    let element: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { get: () => element, configurable: true });
    const fs = new FullScreen(window);
    fs.enter();
    expect(request).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 0));
    element = document.documentElement;
    fs.exit();
    expect(exit).toHaveBeenCalledOnce();

    // Already full screen (the viewer's own F11): neither entered nor left.
    request.mockClear();
    exit.mockClear();
    const again = new FullScreen(window);
    again.enter();
    again.exit();
    expect(request).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("after a hand-off, stays full screen through the web client's player and leaves when it goes back", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", { value: () => Promise.resolve(), configurable: true });
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
    let element: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { get: () => element, configurable: true });
    const fs = new FullScreen(window);
    fs.enter();
    await new Promise((r) => setTimeout(r, 0));
    element = document.documentElement;
    go(`#/details?id=${SERIES}`);
    fs.exitAfterVideo();
    const hash = async (to: string) => {
      go(to);
      await new Promise((r) => setTimeout(r, 0));
    };
    await hash("#/video");
    await hash("#/video?x=1");
    expect(exit).not.toHaveBeenCalled();
    await hash(`#/details?id=${SERIES}`);
    expect(exit).toHaveBeenCalledOnce();
  });
});
