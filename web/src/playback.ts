// What plays a title cell on the page opened by hand (DiscMenu/Player/?item= or ?pack=): StubPlayback only shows what
// would play and runs a clock, so the menus can be followed without playing anything. In the Disc menu button's
// overlay the page plays no title at all: it hands the title to the web client's own player (see handoff.ts).
import { PlayRequest, requestKey, subtitleLabel } from "./media.js";

export * from "./media.js";
export * from "./jellyfin.js";

export class StubPlayback {
  readonly el: HTMLElement;
  key: string | null = null;
  ontime: (t: number) => void = () => {};
  onended: () => void = () => {};
  private t = 0;
  private timer: number | null = null;
  private readonly info: HTMLElement;
  private readonly clock: HTMLElement;
  private label = "";
  private length = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "stub";
    this.info = document.createElement("div");
    this.clock = document.createElement("div");
    this.clock.className = "stub-clock";
    const bar = document.createElement("div");
    bar.className = "stub-buttons";
    const btn = (text: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.onclick = fn;
      bar.append(b);
    };
    btn("+10 s", () => this.jump(10));
    btn("+1 min", () => this.jump(60));
    btn("+5 min", () => this.jump(300));
    btn("End of file", () => this.finish());
    const note = document.createElement("p");
    note.className = "stub-note";
    note.textContent = "Nothing plays on this page: this shows what would play. The clock runs at normal speed.";
    this.el.append(this.info, this.clock, bar, note);
  }

  load(r: PlayRequest): void {
    this.stop();
    this.key = requestKey(r);
    this.label = r.label;
    this.length = r.length;
    this.info.textContent =
      `Would play: ${r.title} from ${fmt(r.offset)} ` +
      `| audio ${r.audioLang3 ?? "default"} | subtitles ${subtitleLabel(r)}`;
    this.t = r.offset;
    this.tick();
    this.timer = window.setInterval(() => {
      this.t += 0.25;
      this.tick();
    }, 250);
  }

  seek(t: number): void {
    this.t = t;
    this.tick();
  }

  time(): number {
    return this.t;
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.key = null;
  }

  private jump(s: number): void {
    this.t = Math.min(this.t + s, this.length);
    this.tick();
  }

  private finish(): void {
    this.stop();
    this.onended();
  }

  private tick(): void {
    this.clock.textContent = `${fmt(this.t)} / ${fmt(this.length)}   ${this.label}`;
    if (this.t >= this.length) return this.finish();
    this.ontime(this.t);
  }
}

export function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
