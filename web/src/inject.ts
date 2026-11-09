// The Disc menu button in Jellyfin's web client. JavaScript Injector runs the plugin's loader on every page of the web
// client once a user is signed in, and the loader adds this script (DiscMenu/Inject/button.js, served by the plugin).
// On a series' or movie's details page, when the item has a menu pack, it puts a "Disc menu" button next to Play.
// The button opens the player page over the web client, full screen, in an iframe on the same origin, so the player
// reuses the web client's login. Closing the overlay stops the playing title first (see embed.ts).
//
// This runs inside the web client with the signed-in user's token, so it never turns data into markup: elements are
// built with createElement, textContent and setAttribute only (test/safety.test.ts fails on the alternatives), the
// item id must look like a Jellyfin id, and every address is built with URL and must stay on this origin.
import { CLOSE, CLOSE_REQUEST, CLOSED, embedMessage, isBackKey } from "./embed.js";

export const BUTTON_CLASS = "btnDiscMenu";
export const OVERLAY_ID = "discMenuOverlay";
/** How long a details page's "has packs" answer is kept. */
const CACHE_MS = 60_000;
/** How long Close waits for the player to stop its title before it removes the iframe anyway. */
const CLOSE_WAIT_MS = 2000;

/** The web client's API client: only the parts the button uses. */
export interface ApiClientLike {
  accessToken(): string | null | undefined;
  serverId(): string | null | undefined;
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

const ITEM_ID = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  /** Opens the player over the page. */
  open(id: string, opener: HTMLElement): void {
    if (this.overlay) return;
    this.overlay = new Overlay(this.win, playerUrl(this.root, id), opener, () => (this.overlay = null));
  }

  /** The open overlay, if any (for tests). */
  get current(): Overlay | null {
    return this.overlay;
  }
}

/** The full-screen overlay: a bar with Close, and the player page in an iframe. */
export class Overlay {
  readonly el: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  private closing: Promise<void> | null = null;
  private readonly overflow: string;
  private readonly onMessage = (e: MessageEvent) => {
    const type = embedMessage(e, this.frame.contentWindow, this.win.location.origin);
    if (type === CLOSE_REQUEST) void this.close();
    else if (type === CLOSED) this.stopped?.();
  };
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || isBackKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      void this.close();
    }
  };
  // Back (the browser's, or Android's back gesture) and any navigation close the overlay.
  private readonly onHistory = () => void this.close(true);
  private stopped: (() => void) | null = null;

  constructor(
    private readonly win: Window,
    src: string,
    private readonly opener: HTMLElement,
    private readonly onClosed: () => void,
  ) {
    const doc = win.document;
    this.el = doc.createElement("div");
    this.el.id = OVERLAY_ID;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.el.setAttribute("aria-label", "Disc menu");
    Object.assign(this.el.style, {
      position: "fixed", inset: "0", zIndex: "100000", background: "#000", display: "flex", flexDirection: "column",
    });

    const bar = doc.createElement("div");
    Object.assign(bar.style, { display: "flex", justifyContent: "flex-end", padding: "4px 8px", flex: "none" });
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "button-flat paper-icon-button-light discMenuClose";
    close.title = "Close";
    close.setAttribute("aria-label", "Close disc menu");
    const icon = doc.createElement("span");
    icon.className = "material-icons close";
    icon.setAttribute("aria-hidden", "true");
    close.append(icon);
    close.addEventListener("click", () => void this.close());
    bar.append(close);

    this.frame = doc.createElement("iframe");
    this.frame.title = "Disc menu player";
    this.frame.setAttribute("allow", "autoplay; fullscreen");
    Object.assign(this.frame.style, { flex: "1", width: "100%", border: "0", background: "#000" });
    this.frame.src = src;
    this.frame.addEventListener("load", () => {
      this.frame.focus();
      this.frame.contentWindow?.focus();
    });

    this.el.append(bar, this.frame);
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

  /**
   * Asks the player to stop its title (and its transcode), waits for the answer or a timeout, then removes the
   * overlay. `fromHistory` when Back or a navigation closed it, so our history entry is already gone.
   */
  close(fromHistory = false): Promise<void> {
    this.closing ??= (async () => {
      this.win.removeEventListener("popstate", this.onHistory);
      this.win.removeEventListener("hashchange", this.onHistory);
      const answered = new Promise<void>((resolve) => {
        this.stopped = resolve;
        this.win.setTimeout(resolve, CLOSE_WAIT_MS);
      });
      try {
        this.frame.contentWindow?.postMessage({ type: CLOSE }, this.win.location.origin);
      } catch {
        this.stopped?.();
      }
      await answered;
      this.win.removeEventListener("message", this.onMessage);
      this.el.remove();
      this.win.document.documentElement.style.overflow = this.overflow;
      if (!fromHistory && (this.win.history.state as { discMenu?: boolean } | null)?.discMenu) this.win.history.back();
      this.onClosed();
      if (this.opener.isConnected) this.opener.focus();
    })();
    return this.closing;
  }
}
