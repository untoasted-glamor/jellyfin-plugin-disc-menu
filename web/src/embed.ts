// The messages between the Disc menu button's overlay (in the web client) and the player page in its iframe. Both
// sides are on the same origin, and each accepts a message only from the other window and from that origin.
//
// The overlay sends CLOSE when the viewer closes it; the player stops its title (and the title's transcode on the
// server) and answers CLOSED, then the overlay removes the iframe. The player sends CLOSE_REQUEST when the viewer
// presses a remote's Back key inside it.

export const CLOSE = "discmenu:close";
export const CLOSED = "discmenu:closed";
export const CLOSE_REQUEST = "discmenu:close-request";

export type EmbedMessage = typeof CLOSE | typeof CLOSED | typeof CLOSE_REQUEST;

/** The message's type, when it is one of ours from `from` on our own origin; null for anything else. */
export function embedMessage(e: MessageEvent, from: MessageEventSource | null, origin: string): EmbedMessage | null {
  if (!from || e.source !== from || e.origin !== origin) return null;
  const type = (e.data as { type?: unknown } | null)?.type;
  return type === CLOSE || type === CLOSED || type === CLOSE_REQUEST ? type : null;
}

/** Whether a key event's target is a form field, where Backspace edits text. */
export function typing(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return !!t?.closest?.("input, textarea, select, [contenteditable]");
}

/**
 * A remote's or keyboard's Back key: BrowserBack/GoBack, webOS's Back (461), Tizen's Return (10009), and Backspace
 * outside a form field. Escape is not one: the player uses it as the disc's Menu key.
 */
export function isBackKey(e: KeyboardEvent): boolean {
  if (e.key === "BrowserBack" || e.key === "GoBack" || e.keyCode === 461 || e.keyCode === 10009) return true;
  return e.key === "Backspace" && !typing(e.target);
}

/** Whether the player page runs inside the button's overlay (?embed=1 and framed). */
export function isEmbedded(win: Window, params: URLSearchParams): boolean {
  return params.get("embed") === "1" && win.parent !== win;
}

/**
 * Player side: on CLOSE from the overlay, runs `stop` (at most `timeoutMs`), then answers CLOSED. Returns a function
 * that asks the overlay to close (for the Back key).
 */
export function embedInPlayer(win: Window, stop: () => Promise<void>, timeoutMs = 1500): () => void {
  const origin = win.location.origin;
  win.addEventListener("message", (e) => {
    if (embedMessage(e, win.parent, origin) !== CLOSE) return;
    const timeout = new Promise<void>((resolve) => win.setTimeout(resolve, timeoutMs));
    void Promise.race([stop().catch(() => {}), timeout]).then(() => win.parent.postMessage({ type: CLOSED }, origin));
  });
  return () => win.parent.postMessage({ type: CLOSE_REQUEST }, origin);
}
