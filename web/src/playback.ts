// What plays a title cell. JellyfinPlayback streams the title's file from Jellyfin over HLS (Jellyfin
// transcodes to H.264/AAC and burns in the chosen subtitle); StubPlayback only shows what would play and runs
// a clock, so the menus can be tested without a server.
import Hls from "hls.js";
import { Jellyfin } from "./jellyfin.js";
import { MediaItem, pickStreams, PlayRequest, requestKey, subtitleLabel } from "./media.js";

export * from "./media.js";
export * from "./jellyfin.js";

export interface Playback {
  readonly el: HTMLElement;
  key: string | null;
  load(r: PlayRequest): Promise<void>;
  seek(t: number): void;
  time(): number;
  stop(): void;
  ontime: (t: number) => void;
  onended: () => void;
  onerror: (msg: string) => void;
}

// ---------------------------------------------------------------------------- stub

export class StubPlayback implements Playback {
  readonly el: HTMLElement;
  key: string | null = null;
  ontime: (t: number) => void = () => {};
  onended: () => void = () => {};
  onerror: (msg: string) => void = () => {};
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
    note.textContent = "No Jellyfin connection: this shows what would play. The clock runs at normal speed.";
    this.el.append(this.info, this.clock, bar, note);
  }

  async load(r: PlayRequest): Promise<void> {
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

// ---------------------------------------------------------------------------- Jellyfin

export class JellyfinPlayback implements Playback {
  readonly el: HTMLVideoElement;
  key: string | null = null;
  ontime: (t: number) => void = () => {};
  onended: () => void = () => {};
  onerror: (msg: string) => void = () => {};
  private hls: Hls | null = null;
  private session: string | null = null;

  constructor(
    private readonly jf: Jellyfin,
    private readonly items: Map<string, MediaItem>,
  ) {
    this.el = document.createElement("video");
    this.el.className = "title-video";
    this.el.controls = true;
    this.el.playsInline = true;
    this.el.addEventListener("timeupdate", () => this.ontime(this.el.currentTime));
    this.el.addEventListener("ended", () => this.onended());
  }

  /** The item and Jellyfin stream indexes a request maps to (see pickStreams). */
  pick(r: PlayRequest): { item: MediaItem; audio: number | null; sub: number | null } {
    const item = this.items.get(r.media);
    if (!item) throw new Error(`${r.title} isn't in Jellyfin`);
    return { item, ...pickStreams(item.streams, r) };
  }

  async load(r: PlayRequest): Promise<void> {
    this.stop();
    let p;
    try {
      p = this.pick(r);
    } catch (e) {
      this.onerror(String((e as Error).message));
      return;
    }
    this.key = requestKey(r);
    this.session = Math.random().toString(36).slice(2);
    const url = this.jf.streamUrl(p.item, p.audio, p.sub, this.session);
    if (Hls.isSupported()) {
      this.hls = new Hls({ startPosition: r.offset });
      this.hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) this.onerror(`stream error: ${d.type} ${d.details}`);
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.el);
    } else {
      // Safari plays HLS itself.
      this.el.src = url;
      this.el.addEventListener("loadedmetadata", () => (this.el.currentTime = r.offset), { once: true });
    }
    this.el.play().catch(() => {});
  }

  seek(t: number): void {
    this.el.currentTime = t;
  }

  time(): number {
    return this.el.currentTime;
  }

  stop(): void {
    this.el.pause();
    if (this.hls) this.hls.destroy();
    this.hls = null;
    this.el.removeAttribute("src");
    this.el.load();
    if (this.session) this.jf.stopEncoding(this.session);
    this.session = null;
    this.key = null;
  }
}
