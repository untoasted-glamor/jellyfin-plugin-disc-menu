// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://jf.test/jellyfin/web/index.html"}
// The Disc menu button in the web client: where it goes, when it shows, and the overlay it opens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE, CLOSE_REQUEST, CLOSED } from "../src/embed.js";
import { BUTTON_CLASS, DiscMenuButton, detailsItemId, OVERLAY_ID, playerUrl, serverRootFrom } from "../src/inject.js";

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

const api = { accessToken: () => "tok123", serverId: () => SERVER_ID };

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

  async function opened() {
    detailsPage();
    go(`#/details?id=${SERIES}`);
    // Let that navigation's hashchange go by: the overlay closes on any navigation.
    await new Promise((r) => setTimeout(r, 0));
    const button = new DiscMenuButton(window, ROOT, () => api, server().fetcher);
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
  function fromPlayer(frame: HTMLIFrameElement, type: string, origin = window.location.origin): void {
    window.dispatchEvent(new MessageEvent("message", { data: { type }, origin, source: frame.contentWindow }));
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
  });

  it("Close asks the player to stop and waits for its answer before removing the frame", async () => {
    const { button, overlay, player } = await opened();
    const posted = player.postMessage;
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    document.querySelector<HTMLButtonElement>(".discMenuClose")!.click();
    expect(posted).toHaveBeenCalledWith({ type: CLOSE }, window.location.origin);
    await Promise.resolve();
    expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
    fromPlayer(overlay.frame, CLOSED);
    await overlay.close();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(button.current).toBeNull();
    expect(back).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(document.querySelector(`.${BUTTON_CLASS}`));
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("closes anyway when the player doesn't answer", async () => {
    const { overlay } = await opened();
    vi.useFakeTimers();
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    const closing = overlay.close();
    await vi.advanceTimersByTimeAsync(2100);
    await closing;
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  it("closes on the player's Back key, and ignores messages from elsewhere", async () => {
    const { overlay } = await opened();
    vi.useFakeTimers();
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    fromPlayer(overlay.frame, CLOSE_REQUEST, "http://evil.test");
    window.dispatchEvent(new MessageEvent("message", { data: { type: CLOSE_REQUEST }, origin: window.location.origin, source: window }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
    fromPlayer(overlay.frame, CLOSE_REQUEST);
    fromPlayer(overlay.frame, CLOSED);
    await overlay.close();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  it("Back closes it without going back a second time", async () => {
    const { overlay } = await opened();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    fromPlayer(overlay.frame, CLOSED);
    await overlay.close();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(back).not.toHaveBeenCalled();
  });

  it("Escape or Back on the overlay's own bar closes it", async () => {
    const { overlay } = await opened();
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    const close = document.querySelector<HTMLButtonElement>(".discMenuClose")!;
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    fromPlayer(overlay.frame, CLOSED);
    await overlay.close();
    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  it("opens one overlay at a time", async () => {
    const { button, overlay } = await opened();
    document.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`)!.click();
    expect(button.current).toBe(overlay);
    expect(document.querySelectorAll(`#${OVERLAY_ID}`).length).toBe(1);
  });
});
