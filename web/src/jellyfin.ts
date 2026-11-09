// The Jellyfin server the page is served from: who is signed in, and the calls the player makes.
//
// A login comes from one of two places. In a browser the page shares the web client's origin, so it reuses the
// login the web client keeps in local storage (jellyfin_credentials, from jellyfin-apiclient's Credentials class).
// Otherwise the page signs in itself, with Quick Connect or a user name and password, and keeps that login under
// its own key. A reused token is sent on its own, with no client or device name: the server renames a token's
// device to whatever a request names, so naming the page would rename the web client's device.
import { DiscInfo, DiscMedia, MediaItem } from "./media.js";

declare const __PLAYER_VERSION__: string;

/** A signed-in user's token. `web` is the web client's own login, reused; `page` is one this page signed in. */
export interface Login {
  token: string;
  userId: string;
  source: "web" | "page";
}

/** The parts of Storage the page uses, so tests can pass a plain map. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or a store that keeps nothing where the browser refuses it (some private windows). */
export function browserStore(): KeyValueStore {
  try {
    const s = window.localStorage;
    s.getItem("discmenu.deviceId");
    return s;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

function readJson(store: KeyValueStore, key: string): unknown {
  try {
    return JSON.parse(store.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

const sameId = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** The web client's saved login for this server (matched by server id), if it has one with a token. */
export function webClientLogin(store: KeyValueStore, serverId: string): Login | null {
  const saved = readJson(store, "jellyfin_credentials") as { Servers?: unknown } | null;
  const servers = Array.isArray(saved?.Servers) ? (saved.Servers as Record<string, unknown>[]) : [];
  const s = servers.find((x) => x && sameId(x.Id, serverId) && x.AccessToken && x.UserId);
  return s ? { token: String(s.AccessToken), userId: String(s.UserId), source: "web" } : null;
}

const PAGE_LOGINS = "discmenu.logins";
type PageLogins = Record<string, { token: string; userId: string }>;

function pageLogins(store: KeyValueStore): PageLogins {
  const v = readJson(store, PAGE_LOGINS);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as PageLogins) : {};
}

/** The login this page signed in itself on this server, if any. */
export function pageLogin(store: KeyValueStore, serverId: string): Login | null {
  const l = pageLogins(store)[serverId.toLowerCase()];
  return l?.token && l.userId ? { token: l.token, userId: l.userId, source: "page" } : null;
}

export function savePageLogin(store: KeyValueStore, serverId: string, token: string, userId: string): Login {
  const all = pageLogins(store);
  all[serverId.toLowerCase()] = { token, userId };
  try {
    store.setItem(PAGE_LOGINS, JSON.stringify(all));
  } catch {
    /* storage full or refused: the login lasts for this page only */
  }
  return { token, userId, source: "page" };
}

export function forgetPageLogin(store: KeyValueStore, serverId: string): void {
  const all = pageLogins(store);
  delete all[serverId.toLowerCase()];
  try {
    if (Object.keys(all).length) store.setItem(PAGE_LOGINS, JSON.stringify(all));
    else store.removeItem(PAGE_LOGINS);
  } catch {
    /* nothing kept anyway */
  }
}

/** The logins to try, in order: the one this page signed in (the viewer chose it here), then the web client's. */
export function savedLogins(store: KeyValueStore, serverId: string): Login[] {
  return [pageLogin(store, serverId), webClientLogin(store, serverId)].filter((l): l is Login => l !== null);
}

/** This browser's device id for the page's own logins and its streams; made once and kept. */
export function deviceId(store: KeyValueStore): string {
  let id = store.getItem("discmenu.deviceId") ?? "";
  if (!id) {
    id = "disc-menu-" + Math.random().toString(36).slice(2);
    try {
      store.setItem("discmenu.deviceId", id);
    } catch {
      /* a new id per page load, then */
    }
  }
  return id;
}

/**
 * The Authorization header. The page names itself when it has no token (signing in) or its own token; a reused web
 * client token goes alone, so the server keeps the web client's device name and version.
 */
export function authHeader(device: string, login: Login | null): string {
  if (login?.source === "web") return `MediaBrowser Token="${login.token}"`;
  const head = `MediaBrowser Client="Disc Menu", Device="Browser", DeviceId="${device}", Version="${__PLAYER_VERSION__}"`;
  return login ? `${head}, Token="${login.token}"` : head;
}

/** The Jellyfin server this page is served from. Every URL is relative to it, so a base URL such as /jellyfin works. */
export function serverRoot(): string {
  return new URL(document.documentElement.dataset.serverRoot ?? "../", location.href).href;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PublicInfo {
  Id: string;
  ServerName?: string;
}

export interface QuickConnectState {
  Secret: string;
  Code: string;
  Authenticated: boolean;
}

interface AuthResult {
  AccessToken: string;
  User: { Id: string; Name: string };
}

export class Jellyfin {
  readonly base: string;
  readonly deviceId: string;

  constructor(
    base: string,
    readonly login: Login | null,
    store: KeyValueStore = browserStore(),
    private readonly fetcher: typeof fetch = (...a) => fetch(...a),
  ) {
    this.base = base.endsWith("/") ? base : base + "/";
    this.deviceId = deviceId(store);
  }

  /** The same server with another login. */
  as(login: Login | null, store?: KeyValueStore): Jellyfin {
    return new Jellyfin(this.base, login, store, this.fetcher);
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: authHeader(this.deviceId, this.login) };
    if (init.body) headers["Content-Type"] = "application/json";
    const r = await this.fetcher(this.base + path, { ...init, headers });
    if (!r.ok) throw new HttpError(r.status, `${r.status} ${r.statusText} for ${path.split("?")[0]}`);
    return r;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.call(path)).json()) as T;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const r = await this.call(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
    return (r.status === 204 ? null : await r.json()) as T;
  }

  /** A URL for an element that can't send a header (img, video, audio): the token goes in ApiKey=. */
  withKey(url: string): string {
    if (!this.login) return url;
    return `${url}${url.includes("?") ? "&" : "?"}ApiKey=${encodeURIComponent(this.login.token)}`;
  }

  // ---- signing in (no login needed) ----

  /** The server's id and name; needs no login. */
  publicInfo(): Promise<PublicInfo> {
    return this.get<PublicInfo>("System/Info/Public");
  }

  /** The signed-in user's name, which also checks the token still works. */
  async userName(): Promise<string> {
    return (await this.get<{ Name: string }>("Users/Me")).Name;
  }

  async signIn(user: string, password: string): Promise<{ token: string; userId: string; name: string }> {
    const r = await this.post<AuthResult>("Users/AuthenticateByName", { Username: user, Pw: password });
    return { token: r.AccessToken, userId: r.User.Id, name: r.User.Name };
  }

  /** Whether the server's admin has Quick Connect on (Dashboard > General). */
  async quickConnectEnabled(): Promise<boolean> {
    try {
      return (await this.get<boolean>("QuickConnect/Enabled")) === true;
    } catch {
      return false;
    }
  }

  /** Starts a Quick Connect request: a code to approve on a signed-in device, and the secret to finish it with. */
  quickConnectStart(): Promise<QuickConnectState> {
    return this.post<QuickConnectState>("QuickConnect/Initiate");
  }

  /** The request's state; 404 once it has expired (after ten minutes). */
  quickConnectState(secret: string): Promise<QuickConnectState> {
    return this.get<QuickConnectState>(`QuickConnect/Connect?secret=${encodeURIComponent(secret)}`);
  }

  async quickConnectFinish(secret: string): Promise<{ token: string; userId: string; name: string }> {
    const r = await this.post<AuthResult>("Users/AuthenticateWithQuickConnect", { Secret: secret });
    return { token: r.AccessToken, userId: r.User.Id, name: r.User.Name };
  }

  /** Ends this page's own login on the server, which removes its device there. Never used on a reused login. */
  async signOut(): Promise<void> {
    if (this.login?.source !== "page") return;
    await this.post<null>("Sessions/Logout").catch(() => {});
  }

  // ---- the plugin ----

  /** The plugin's address for a series' or movie's packs. */
  discsPath(item: string): string {
    return `DiscMenu/Items/${encodeURIComponent(item)}/Discs`;
  }

  discs(item: string): Promise<DiscInfo[]> {
    return this.get<DiscInfo[]>(this.discsPath(item));
  }

  /** Which library item plays each file the pack names, with its streams (looked up on every call). */
  media(item: string, disc: string): Promise<DiscMedia> {
    return this.get<DiscMedia>(`${this.discsPath(item)}/${encodeURIComponent(disc)}/Media`);
  }

  // ---- streaming ----

  streamUrl(item: MediaItem, audio: number | null, sub: number | null, playSessionId: string): string {
    const q = new URLSearchParams({
      MediaSourceId: item.mediaSourceId,
      DeviceId: this.deviceId,
      PlaySessionId: playSessionId,
      VideoCodec: "h264",
      AudioCodec: "aac",
      TranscodingMaxAudioChannels: "2",
      VideoBitrate: "8000000",
      AudioBitrate: "192000",
      SegmentContainer: "ts",
      MinSegments: "1",
      BreakOnNonKeyFrames: "True",
    });
    if (this.login) q.set("ApiKey", this.login.token);
    if (audio !== null) q.set("AudioStreamIndex", String(audio));
    if (sub !== null) {
      q.set("SubtitleStreamIndex", String(sub));
      q.set("SubtitleMethod", "Encode");
    }
    return `${this.base}Videos/${item.id}/master.m3u8?${q}`;
  }

  stopEncoding(playSessionId: string): void {
    const q = new URLSearchParams({ deviceId: this.deviceId, playSessionId });
    this.call(`Videos/ActiveEncodings?${q}`, { method: "DELETE" }).catch(() => {});
  }
}
