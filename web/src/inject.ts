// The Disc menu button in Jellyfin's web client. JavaScript Injector runs the plugin's loader on every page of the web
// client once a user is signed in, and the loader adds this script (DiscMenu/Inject/button.js, served by the plugin).
// On a series' or movie's details page, when the item has a menu pack, it puts a "Disc menu" button next to Play.
// The button opens the player page over the web client, full screen, in an iframe on the same origin, so the player
// reuses the web client's login. When the disc starts a title, the overlay closes and the web client's own player
// plays it, through a Play command the server sends to this web client's own session (Handoff, below). What the hand-off
// did goes into the tab's Disc menu log (debuglog.ts), which the next open's Stats panel shows.
//
// This runs inside the web client with the signed-in user's token, so it never turns data into markup: elements are
// built with createElement, textContent and setAttribute only (test/safety.test.ts fails on the alternatives), the
// item id must look like a Jellyfin id, and every address is built with URL and must stay on this origin.
import { appendEvent, Level, tabStore } from "./debuglog.js";
import { CHECK, CHECKED, CheckResult, CLOSE_REQUEST, embedMessage, isBackKey, ITEM_ID, PLAY, PlayHandoff } from "./embed.js";

export const BUTTON_CLASS = "btnDiscMenu";
export const OVERLAY_ID = "discMenuOverlay";
/** How long a details page's "has packs" answer is kept. */
const CACHE_MS = 60_000;

/** The web client's API client: only the parts the button uses. */
export interface ApiClientLike {
  accessToken(): string | null | undefined;
  serverId(): string | null | undefined;
  /** The web client's session is found by these three (the server keys sessions by client, device and user). */
  deviceId(): string | null | undefined;
  appName(): string | null | undefined;
  getCurrentUserId(): string | null | undefined;
}

/** The server root (with any base URL) from this script's own address, .../DiscMenu/Inject/button.js. */
export function serverRootFrom(scriptSrc: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL("../../", scriptSrc);
  } catch {
    return null;
  }
  return u.origin === origin ? u.href : null;
}

/** The item id of a details page (#/details?id=...), or null for any other page or an id that isn't one. */
export function detailsItemId(hash: string): string | null {
  if (!/^#!?\/details\?/.test(hash)) return null;
  const id = new URLSearchParams(hash.slice(hash.indexOf("?") + 1)).get("id");
  return id && ITEM_ID.test(id) ? id : null;
}

/** The player page for an item, inside the overlay. */
export function playerUrl(root: string, itemId: string): string {
  const u = new URL("DiscMenu/Player/", root);
  u.searchParams.set("item", itemId);
  u.searchParams.set("embed", "1");
  return u.href;
}

const authHeader = (token: string) => ({ Authorization: `MediaBrowser Token="${token}"` });

/**
 * The web client's ApiClient keeps its app name and device id URI-encoded (it encodes them for its Authorization header
 * and decodes them for its SDK); the server stores them decoded.
 */
function decoded(v: string | null | undefined): string {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Ids compared the way the server writes them: no dashes, any case. */
const sameId = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();

export class DiscMenuButton {
  private readonly cache = new Map<string, { at: number; has: Promise<boolean> }>();
  private sameServer: Promise<boolean> | null = null;
  private overlay: Overlay | null = null;
  private queued = false;

  constructor(
    private readonly win: Window,
    private readonly root: string,
    private readonly api: () => ApiClientLike | undefined,
    private readonly fetcher: typeof fetch = (...a) => win.fetch(...a),
  ) {}

  /** Watches the web client for details pages: on navigation, and on DOM changes (the page draws its buttons late). */
  start(): void {
    const doc = this.win.document;
    this.win.addEventListener("hashchange", () => this.queue());
    doc.addEventListener("viewshow", () => this.queue(), true);
    new MutationObserver(() => this.queue()).observe(doc.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-id", "data-type"],
    });
    this.queue();
  }

  private queue(): void {
    if (this.queued) return;
    this.queued = true;
    this.win.requestAnimationFrame(() => {
      this.queued = false;
      void this.refresh();
    });
  }

  /** Adds the button to the visible details page when its item has packs, and removes a stale one. */
  async refresh(): Promise<void> {
    const doc = this.win.document;
    const page = doc.querySelector(".itemDetailPage:not(.hide)");
    const box = page?.querySelector(".mainDetailButtons");
    const id = detailsItemId(this.win.location.hash);
    for (const b of doc.querySelectorAll<HTMLElement>(`.${BUTTON_CLASS}`)) {
      if (b.parentElement !== box || b.dataset.item !== id) b.remove();
    }
    if (!box || !id || box.querySelector(`.${BUTTON_CLASS}`)) return;
    // The page's own buttons (played state, favourite) name its item and type. Until they name this item, the page
    // still shows the last one; only series and movies have packs.
    const own = box.querySelector<HTMLElement>("[data-id][data-type]");
    if (!own || own.dataset.id?.toLowerCase() !== id.toLowerCase()) return;
    if (own.dataset.type !== "Series" && own.dataset.type !== "Movie") return;
    if (!(await this.hasDiscs(id))) return;
    // The viewer may have moved on while the answer came back.
    if (detailsItemId(this.win.location.hash) !== id || !box.isConnected || box.querySelector(`.${BUTTON_CLASS}`)) return;
    const play = box.querySelector(".btnPlay");
    const button = this.button(id);
    if (play) play.after(button);
    else box.prepend(button);
  }

  private button(id: string): HTMLButtonElement {
    const doc = this.win.document;
    const b = doc.createElement("button");
    b.type = "button";
    b.className = `button-flat detailButton emby-button ${BUTTON_CLASS}`;
    b.title = "Disc menu";
    b.setAttribute("aria-label", "Disc menu");
    b.dataset.item = id;
    const content = doc.createElement("div");
    content.className = "detailButton-content";
    const icon = doc.createElement("span");
    icon.className = "material-icons detailButton-icon album";
    icon.setAttribute("aria-hidden", "true");
    content.append(icon);
    b.append(content);
    b.addEventListener("click", () => this.open(id, b));
    return b;
  }

  /** Whether the item has at least one pack this user can read; cached for a minute. */
  hasDiscs(id: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.cache.get(id);
    if (hit && now - hit.at < CACHE_MS) return hit.has;
    const has = this.askDiscs(id);
    this.cache.set(id, { at: now, has });
    return has;
  }

  private async askDiscs(id: string): Promise<boolean> {
    const token = this.api()?.accessToken();
    if (!token || !(await this.onThisServer())) return false;
    try {
      const r = await this.fetcher(new URL(`DiscMenu/Items/${encodeURIComponent(id)}/Discs`, this.root).href, {
        headers: authHeader(token),
      });
      if (!r.ok) return false;
      const discs = (await r.json()) as unknown;
      return Array.isArray(discs) && discs.length > 0;
    } catch {
      return false;
    }
  }

  /** Whether the web client is signed in to the server this script came from (it can switch servers). */
  private onThisServer(): Promise<boolean> {
    this.sameServer ??= (async () => {
      try {
        const r = await this.fetcher(new URL("System/Info/Public", this.root).href);
        const info = (await r.json()) as { Id?: unknown };
        const mine = this.api()?.serverId();
        return typeof info.Id === "string" && !!mine && info.Id.toLowerCase() === mine.toLowerCase();
      } catch {
        return false;
      }
    })();
    return this.sameServer;
  }

  /** Opens the player over the page, full screen. Runs in the button's click, which full screen needs. */
  open(id: string, opener: HTMLElement): void {
    if (this.overlay) return;
    const screen = new FullScreen(this.win);
    screen.enter();
    this.overlay = new Overlay(this.win, playerUrl(this.root, id), opener, screen, {
      closed: () => (this.overlay = null),
      play: (h, overlay) => void this.handOff(h, overlay, screen),
      check: (h, overlay) => void this.check(h, overlay),
    });
  }

  /** "Wait before playing from menu": everything a hand-off does but the Play command, answered to the player. */
  private async check(h: PlayHandoff, overlay: Overlay): Promise<void> {
    const api = this.api();
    const result = api
      ? await new Handoff(this.win, this.root, api, this.fetcher).check(h)
      : { session: null, detail: "The web client has no API client: the real hand-off would open the details page." };
    overlay.reply(result);
  }

  /** The player handed a title over: the overlay goes, then the web client's player plays it (see Handoff). */
  private async handOff(h: PlayHandoff, overlay: Overlay, screen: FullScreen): Promise<void> {
    const hash = this.win.location.hash;
    await overlay.leave();
    const api = this.api();
    const result = api ? await new Handoff(this.win, this.root, api, this.fetcher).run(h, hash) : "fallback";
    // Playing, or the web client went on to its player by itself: full screen stays for the episode.
    if (result === "playing" || (result === "moved" && /^#!?\/video\b/.test(this.win.location.hash))) screen.exitAfterVideo();
    else screen.exit();
  }

  /** The open overlay, if any (for tests). */
  get current(): Overlay | null {
    return this.overlay;
  }
}

/** What the web client's NativeShell offers (the Android app); a browser has none. */
interface NativeShellLike {
  enableFullscreen?(): void;
  disableFullscreen?(): void;
}

/** The parts of ScreenOrientation the overlay uses; lock() isn't in every browser or in TypeScript's DOM types. */
interface OrientationLike {
  lock?(o: string): Promise<void>;
  unlock?(): void;
}

/**
 * Full screen for the menu, the way the web client's episode player has it. The Android app goes full screen and
 * landscape through NativeShell (its WebView can't do requestFullscreen); a browser goes full screen on the whole
 * document, so the episode player that follows a hand-off stays full screen, and turns landscape where it may.
 * exit() undoes only what enter() did.
 */
export class FullScreen {
  private native = false;
  private doc = false;
  private locked = false;
  private watching: (() => void) | null = null;

  constructor(private readonly win: Window) {}

  private get shell(): NativeShellLike | undefined {
    return (this.win as unknown as { NativeShell?: NativeShellLike }).NativeShell;
  }

  /** In the button's click: full screen needs the viewer's gesture. Failures are ignored. */
  enter(): void {
    const shell = this.shell;
    if (shell?.enableFullscreen) {
      try {
        shell.enableFullscreen();
        this.native = true;
      } catch {
        /* the app refused; the overlay still covers the page */
      }
      return;
    }
    const doc = this.win.document;
    if (doc.fullscreenElement || !doc.documentElement.requestFullscreen) return;
    let asked: Promise<void>;
    try {
      asked = doc.documentElement.requestFullscreen();
    } catch {
      return;
    }
    void Promise.resolve(asked)
      .then(() => {
        this.doc = true;
        const o = this.win.screen?.orientation as OrientationLike | undefined;
        return o?.lock?.("landscape").then(() => {
          this.locked = true;
        });
      })
      .catch(() => {});
  }

  exit(): void {
    this.watching?.();
    if (this.native) this.shell?.disableFullscreen?.();
    if (this.locked) (this.win.screen?.orientation as OrientationLike | undefined)?.unlock?.();
    const doc = this.win.document;
    if (this.doc && doc.fullscreenElement && doc.exitFullscreen) void doc.exitFullscreen().catch(() => {});
    this.native = this.doc = this.locked = false;
  }

  /**
   * After a hand-off in a browser: stays full screen while the web client's player plays (#/video), and leaves it
   * once the web client goes back to another page. In the app, the native player resets full screen itself.
   */
  exitAfterVideo(maxMs = 6 * 3600_000): void {
    if (this.native) {
      this.native = false;
      return;
    }
    if (!this.doc && !this.locked) return;
    let sawVideo = false;
    const onHash = () => {
      if (/^#!?\/video\b/.test(this.win.location.hash)) sawVideo = true;
      else if (sawVideo) this.exit();
    };
    const timer = this.win.setTimeout(() => this.exit(), maxMs);
    this.win.addEventListener("hashchange", onHash);
    this.watching = () => {
      this.watching = null;
      this.win.clearTimeout(timer);
      this.win.removeEventListener("hashchange", onHash);
    };
    onHash();
  }
}

/** The overlay's links to the button: it closed, the player handed a title over, or it asked to check one. */
interface OverlayEvents {
  closed(): void;
  play(h: PlayHandoff, overlay: Overlay): void;
  check(h: PlayHandoff, overlay: Overlay): void;
}

/** The full-screen overlay: the player page in an iframe. The player has its own control bar (Close among them). */
export class Overlay {
  readonly el: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  private leaving: Promise<void> | null = null;
  private readonly overflow: string;
  private readonly onMessage = (e: MessageEvent) => {
    const m = embedMessage(e, this.frame.contentWindow, this.win.location.origin);
    if (m?.type === CLOSE_REQUEST) void this.close();
    else if (m?.type === PLAY && !this.leaving) this.events.play(m.play, this);
    else if (m?.type === CHECK && !this.leaving) this.events.check(m.play, this);
  };
  private readonly onKey = (e: KeyboardEvent) => {
    // Keys reach the overlay itself only before the frame has the focus.
    if (e.key === "Escape" || isBackKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      void this.close();
    }
  };
  // Back (the browser's, or Android's back gesture) and any navigation close the overlay.
  private readonly onHistory = () => void this.close(true);

  constructor(
    private readonly win: Window,
    src: string,
    private readonly opener: HTMLElement,
    private readonly screen: FullScreen,
    private readonly events: OverlayEvents,
  ) {
    const doc = win.document;
    this.el = doc.createElement("div");
    this.el.id = OVERLAY_ID;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.el.setAttribute("aria-label", "Disc menu");
    Object.assign(this.el.style, { position: "fixed", inset: "0", zIndex: "100000", background: "#000" });

    this.frame = doc.createElement("iframe");
    this.frame.title = "Disc menu player";
    // clipboard-write: the Stats panel's Copy.
    this.frame.setAttribute("allow", "autoplay; fullscreen; clipboard-write");
    Object.assign(this.frame.style, { width: "100%", height: "100%", border: "0", background: "#000" });
    this.frame.src = src;
    this.frame.addEventListener("load", () => {
      this.frame.focus();
      this.frame.contentWindow?.focus();
    });

    this.el.append(this.frame);
    this.el.addEventListener("keydown", this.onKey);
    win.addEventListener("message", this.onMessage);
    this.overflow = doc.documentElement.style.overflow;
    doc.documentElement.style.overflow = "hidden";
    doc.body.append(this.el);
    // An entry of our own, so Back closes the overlay instead of leaving the page.
    win.history.pushState({ discMenu: true }, "");
    win.addEventListener("popstate", this.onHistory);
    win.addEventListener("hashchange", this.onHistory);
  }

  /** Answers the player's CHECK (on our origin only). */
  reply(result: CheckResult): void {
    if (this.leaving) return;
    this.frame.contentWindow?.postMessage({ type: CHECKED, result }, this.win.location.origin);
  }

  /** Closes the menu with no title handed over: leaves full screen too. */
  async close(fromHistory = false): Promise<void> {
    const first = !this.leaving;
    await this.leave(fromHistory);
    if (first) {
      this.screen.exit();
      if (this.opener.isConnected) this.opener.focus();
    }
  }

  /**
   * Removes the overlay and goes back past its history entry, waiting until that is done, so that what comes next
   * (the web client's player for a hand-off) isn't undone by our Back. `fromHistory` when Back or a navigation closed
   * it, so our entry is already gone. Stays full screen.
   */
  leave(fromHistory = false, waitMs = 1000): Promise<void> {
    this.leaving ??= (async () => {
      this.win.removeEventListener("popstate", this.onHistory);
      this.win.removeEventListener("hashchange", this.onHistory);
      this.win.removeEventListener("message", this.onMessage);
      // Removing the frame unloads the player page, which stops the menu's video and audio.
      this.el.remove();
      this.win.document.documentElement.style.overflow = this.overflow;
      if (!fromHistory && (this.win.history.state as { discMenu?: boolean } | null)?.discMenu) {
        await new Promise<void>((resolve) => {
          const done = () => {
            this.win.removeEventListener("popstate", done);
            this.win.clearTimeout(timer);
            // One more task, so the web client's own popstate handling runs first.
            this.win.setTimeout(resolve, 0);
          };
          const timer = this.win.setTimeout(done, waitMs);
          this.win.addEventListener("popstate", done);
          this.win.history.back();
        });
      }
      this.events.closed();
    })();
    return this.leaving;
  }
}

/** A session as GET Sessions lists it: only the fields the hand-off reads. */
interface SessionLike {
  Id?: string;
  DeviceId?: string;
  Client?: string;
  UserId?: string;
  NowPlayingItem?: { Id?: string } | null;
}

export type HandoffResult = "playing" | "fallback" | "moved";

/** "session 1a2b... (Jellyfin Web on device x)", for the log. */
const describeSession = (s: SessionLike) => `session ${s.Id ?? "?"} (${s.Client ?? "?"} on device ${s.DeviceId ?? "?"})`;

/**
 * Has the web client play a title the menu picked: a Play command (POST Sessions/{id}/Playing) to the web client's
 * own session, the same message a remote control sends. A page script can't start the web client's player itself.
 *
 * The server answers 204 even when the session has no live connection, so the hand-off counts only once the session
 * reports something new playing. When that doesn't happen, the title's details page opens instead, with its own Play
 * button, unless the web client has moved on by itself (its player may just be slow to start: opening another page
 * would stop it).
 */
export class Handoff {
  constructor(
    private readonly win: Window,
    private readonly root: string,
    private readonly api: ApiClientLike,
    private readonly fetcher: typeof fetch = (...a) => win.fetch(...a),
    private readonly timing = { pollMs: 1000, confirmMs: 15_000 },
    private readonly log: (level: Level, s: string) => void = (level, s) => {
      console.info(`[Disc menu] ${s}`);
      appendEvent(tabStore(win), level, `Web client: ${s}`);
    },
  ) {}

  /** `hash` is the web client's address when the hand-off began (the item's details page). */
  async run(h: PlayHandoff, hash: string): Promise<HandoffResult> {
    const token = this.api.accessToken();
    let session: SessionLike | null = null;
    try {
      session = token ? await this.ownSession(token) : null;
      if (!session?.Id) {
        this.log("warn", `${await this.noSession(token)} for ${h.name}`);
        return this.fallback(h, hash, token, null);
      }
      const before = session.NowPlayingItem?.Id ?? null;
      const url = this.playUrl(h, session.Id);
      const r = await this.fetcher(url.href, { method: "POST", headers: authHeader(token!) });
      this.log(r.ok ? "info" : "error", `Play command for ${h.name} to ${describeSession(session)}: HTTP ${r.status} (${url.search.slice(1)})`);
      if (!r.ok) return this.fallback(h, hash, token, session.Id);
      if (await this.confirm(token!, session.Id, h.itemId, before)) {
        this.log("info", `${h.name} is playing`);
        return "playing";
      }
      this.log("warn", `nothing new played within ${this.timing.confirmMs / 1000} s of the Play command`);
      return this.fallback(h, hash, token, session.Id);
    } catch (e) {
      this.log("error", `hand-off failed: ${(e as Error).message}`);
      return this.fallback(h, hash, token, session?.Id ?? null);
    }
  }

  /** "Wait before playing from menu": finds the session and builds the Play command, but doesn't send it. */
  async check(h: PlayHandoff): Promise<CheckResult> {
    const token = this.api.accessToken();
    if (!token) return { session: null, detail: "The web client isn't signed in: the real hand-off would open the details page." };
    try {
      const session = await this.ownSession(token);
      if (!session?.Id) return { session: null, detail: `${await this.noSession(token)}: the real hand-off would open the details page.` };
      const url = this.playUrl(h, session.Id);
      return { session: session.Id, detail: `Would send POST ${url.pathname}${url.search} to ${describeSession(session)}.` };
    } catch (e) {
      return { session: null, detail: `Couldn't read the sessions (${(e as Error).message}): the real hand-off would open the details page.` };
    }
  }

  private playUrl(h: PlayHandoff, sessionId: string): URL {
    const q = new URLSearchParams({ playCommand: "PlayNow", itemIds: [h.itemId, ...(h.queue ?? [])].join(",") });
    if (h.startTicks !== undefined) q.set("startPositionTicks", String(h.startTicks));
    if (h.mediaSourceId !== undefined) q.set("mediaSourceId", h.mediaSourceId);
    if (h.audioIndex !== undefined) q.set("audioStreamIndex", String(h.audioIndex));
    if (h.subtitleIndex !== undefined) q.set("subtitleStreamIndex", String(h.subtitleIndex));
    return new URL(`Sessions/${encodeURIComponent(sessionId)}/Playing?${q}`, this.root);
  }

  /** Why no session matched: what the web client looked for, and what the server lists for its device. */
  private async noSession(token: string | null | undefined): Promise<string> {
    const want = `device ${decoded(this.api.deviceId()) || "(none)"}, client ${decoded(this.api.appName()) || "(none)"}`;
    if (!token) return `No session found (not signed in; ${want})`;
    const list = await this.sessions(token).catch(() => null);
    const seen = list === null ? "the session list couldn't be read" : `the server lists ${list.length} for this device${list.length ? `: ${list.map(describeSession).join("; ")}` : ""}`;
    return `No session of this web client found (${want}; ${seen})`;
  }

  private async sessions(token: string): Promise<SessionLike[]> {
    const q = new URLSearchParams({ deviceId: decoded(this.api.deviceId()) });
    const r = await this.fetcher(new URL(`Sessions?${q}`, this.root).href, { headers: authHeader(token) });
    if (!r.ok) throw new Error(`Sessions: ${r.status}`);
    const list = (await r.json()) as unknown;
    return Array.isArray(list) ? (list as SessionLike[]) : [];
  }

  /** This web client's session: same device, client and user. */
  private async ownSession(token: string): Promise<SessionLike | null> {
    const device = decoded(this.api.deviceId());
    const app = decoded(this.api.appName());
    if (!device) return null;
    const list = await this.sessions(token);
    return (
      list.find(
        (s) =>
          typeof s.DeviceId === "string" && s.DeviceId.toLowerCase() === device.toLowerCase() && s.Client === app &&
          sameId(s.UserId, this.api.getCurrentUserId()),
      ) ?? null
    );
  }

  /** Whether the session starts playing the title, or anything new, within the time allowed. */
  private async confirm(token: string, sessionId: string, itemId: string, before: string | null): Promise<boolean> {
    const end = Date.now() + this.timing.confirmMs;
    for (;;) {
      const s = (await this.sessions(token).catch(() => [])).find((x) => x.Id === sessionId);
      const now = s?.NowPlayingItem?.Id ?? null;
      if (now && (sameId(now, itemId) || !sameId(now, before))) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => this.win.setTimeout(r, this.timing.pollMs));
    }
  }

  /** Opens the title's details page, unless the web client has moved on or the session plays something after all. */
  private async fallback(h: PlayHandoff, hash: string, token: string | null | undefined, sessionId: string | null): Promise<HandoffResult> {
    const moved = (): HandoffResult => {
      this.log("info", `the web client moved on by itself (${this.win.location.hash || "no address"}): no details page`);
      return "moved";
    };
    if (this.win.location.hash !== hash) return moved();
    if (token && sessionId) {
      const s = (await this.sessions(token).catch(() => [])).find((x) => x.Id === sessionId);
      if (s?.NowPlayingItem?.Id || this.win.location.hash !== hash) return moved();
    }
    this.log("warn", `opening the details page of ${h.name} instead`);
    this.win.location.hash = `#/details?id=${encodeURIComponent(h.itemId)}`;
    return "fallback";
  }
}
