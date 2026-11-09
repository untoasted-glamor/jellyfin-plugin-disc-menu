// Menu video and audio the browser refuses to play until the viewer taps the page (the autoplay policy; the Android
// app's WebView is set to need a user gesture for media). A refused video plays muted, so the menu still
// moves; a refused audio waits. The page shows its Start button, and the tap on it plays everything refused, with
// sound.

/** The parts of a media element the gate uses, so tests can pass a fake. */
export interface Playable {
  muted: boolean;
  play(): Promise<void>;
}

const refused = (e: unknown) => (e as { name?: unknown } | null)?.name === "NotAllowedError";

export class AutoplayGate {
  private readonly waiting = new Set<Playable>();

  /** `onRefused` shows the Start button; it runs once per refusal. */
  constructor(private readonly onRefused: () => void) {}

  /** Plays a menu's video or audio, and keeps it for Start when the browser refuses. */
  play(el: Playable, video: boolean): void {
    el.play().catch((e: unknown) => {
      if (!refused(e)) return;
      this.waiting.add(el);
      this.onRefused();
      if (video && !el.muted) {
        el.muted = true;
        el.play().catch(() => {});
      }
    });
  }

  /** Whether something waits for the viewer's tap. */
  get blocked(): boolean {
    return this.waiting.size > 0;
  }

  /** From the Start button's tap: everything refused plays again, with sound. */
  resume(): void {
    for (const el of this.waiting) {
      el.muted = false;
      el.play().catch(() => {});
    }
    this.waiting.clear();
  }

  /** The menu changed: what waited belongs to the old one. */
  clear(): void {
    this.waiting.clear();
  }
}
