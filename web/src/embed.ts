// The messages between the Disc menu button's overlay (in the web client) and the player page in its iframe. Both
// sides are on the same origin, and each accepts a message only from the other window and from that origin.
//
// The player sends CLOSE_REQUEST when the viewer closes the menu (the bar's Close, or a remote's Back key), and PLAY
// when the disc starts a title the library has: the overlay then closes and has the web client play that title (see
// inject.ts). The player plays nothing from the library itself, so closing needs no answer from it.

export const CLOSE_REQUEST = "discmenu:close-request";
export const PLAY = "discmenu:play";

/** A Jellyfin item id: 32 hex digits, or the same with dashes. */
export const ITEM_ID = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A title handed to the web client's player: what goes into the Play command (Sessions/{id}/Playing). */
export interface PlayHandoff {
  itemId: string;
  mediaSourceId?: string;
  /** Where to start, in ticks (100 ns); left out to start at the top. */
  startTicks?: number;
  /** Jellyfin's stream indexes; left out to let Jellyfin pick. The subtitle is -1 for none. */
  audioIndex?: number;
  subtitleIndex?: number;
  /** The title's name, for the log only. */
  name: string;
}

const KEYS = new Set(["itemId", "mediaSourceId", "startTicks", "audioIndex", "subtitleIndex", "name"]);
const NAME_MAX = 200;

const isIndex = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= -1;

/** A PLAY message's data, checked field by field; null for anything else (a wrong type, an extra key, no item). */
export function parsePlay(data: unknown): PlayHandoff | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (Object.keys(d).some((k) => !KEYS.has(k))) return null;
  if (typeof d.itemId !== "string" || !ITEM_ID.test(d.itemId)) return null;
  if (d.mediaSourceId !== undefined && (typeof d.mediaSourceId !== "string" || !ITEM_ID.test(d.mediaSourceId))) return null;
  if (d.startTicks !== undefined && !(Number.isSafeInteger(d.startTicks) && (d.startTicks as number) >= 0)) return null;
  if (d.audioIndex !== undefined && !isIndex(d.audioIndex)) return null;
  if (d.subtitleIndex !== undefined && !isIndex(d.subtitleIndex)) return null;
  if (typeof d.name !== "string" || d.name.length > NAME_MAX) return null;
  const h: PlayHandoff = { itemId: d.itemId, name: d.name };
  if (d.mediaSourceId !== undefined) h.mediaSourceId = d.mediaSourceId as string;
  if (d.startTicks !== undefined) h.startTicks = d.startTicks as number;
  if (d.audioIndex !== undefined) h.audioIndex = d.audioIndex as number;
  if (d.subtitleIndex !== undefined) h.subtitleIndex = d.subtitleIndex as number;
  return h;
}

export type EmbedMessage = { type: typeof CLOSE_REQUEST } | { type: typeof PLAY; play: PlayHandoff };

/** The message, when it is one of ours from `from` on our own origin and well formed; null for anything else. */
export function embedMessage(e: MessageEvent, from: MessageEventSource | null, origin: string): EmbedMessage | null {
  if (!from || e.source !== from || e.origin !== origin) return null;
  const data = e.data as { type?: unknown; play?: unknown } | null;
  if (data?.type === CLOSE_REQUEST) return { type: CLOSE_REQUEST };
  if (data?.type === PLAY) {
    const play = parsePlay(data.play);
    return play ? { type: PLAY, play } : null;
  }
  return null;
}

/** Whether a key event's target is a form field, where Backspace edits text. */
export function typing(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return !!t?.closest?.("input, textarea, select, [contenteditable]");
}

/**
 * A remote's or keyboard's Back key: BrowserBack/GoBack, webOS's Back (461), Tizen's Return (10009), and Backspace
 * outside a form field. Escape is not one: in full screen the browser keeps it for leaving full screen.
 */
export function isBackKey(e: KeyboardEvent): boolean {
  if (e.key === "BrowserBack" || e.key === "GoBack" || e.keyCode === 461 || e.keyCode === 10009) return true;
  return e.key === "Backspace" && !typing(e.target);
}

/** A remote's Info key (webOS and Tizen send keyCode 457), which shows the menu's control bar. */
export function isInfoKey(e: KeyboardEvent): boolean {
  return e.key === "Info" || e.keyCode === 457;
}

/** Whether the player page runs inside the button's overlay (?embed=1 and framed). */
export function isEmbedded(win: Window, params: URLSearchParams): boolean {
  return params.get("embed") === "1" && win.parent !== win;
}

/** Player side: asks the overlay to close, or to hand a title to the web client's player. */
export function embedInPlayer(win: Window): { requestClose(): void; handOff(play: PlayHandoff): void } {
  const origin = win.location.origin;
  return {
    requestClose: () => win.parent.postMessage({ type: CLOSE_REQUEST }, origin),
    handOff: (play) => win.parent.postMessage({ type: PLAY, play }, origin),
  };
}
