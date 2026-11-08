// What plays a title cell. JellyfinPlayback streams the title's file from Jellyfin over HLS (Jellyfin
// transcodes to H.264/AAC and burns in the chosen subtitle); StubPlayback only shows what would play and runs
// a clock, so the menus can be tested without a server.
import Hls from "hls.js";
import type { MediaCell } from "./dvdvm.js";

declare const __PLAYER_VERSION__: string;

export interface PlayRequest {
  /** Which file: "E<n>" for a series episode, "F:<file name>" for a movie (see mediaKey). */
  media: string;
  /** What the viewer sees for it: "S01E03" or the movie's file name. */
  title: string;
  offset: number;
  /** How long the file is, as far as the pack knows (the end of its last cell). */
  length: number;
  audioLang3: string | null;
  /** The chosen subtitle: its sidecar file's suffix when the pack pairs one, and its language. */
  sidecar: string | null;
  subLang3: string | null;
  label: string;
}

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

/** A series episode is found by its number (file names change after a rip); a movie by its file name. */
export const mediaKey = (m: MediaCell): string => (m.episode !== undefined ? `E${m.episode}` : `F:${m.file}`);

export const requestKey = (r: PlayRequest) => `${r.media}|${r.audioLang3}|${r.sidecar}|${r.subLang3}`;

/** How a request's subtitle reads in the status line. */
export const subtitleLabel = (r: PlayRequest) => r.sidecar ?? r.subLang3 ?? "off";

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

interface Stream {
  Index: number;
  Type: string;
  Language?: string;
  Path?: string;
  IsExternal?: boolean;
  DisplayTitle?: string;
}
export interface MediaItem {
  id: string;
  name: string;
  mediaSourceId: string;
  streams: Stream[];
}

/** The Jellyfin server this page is served from. Every URL is relative to it, so a base URL such as /jellyfin works. */
export function serverRoot(): string {
  return new URL(document.documentElement.dataset.serverRoot ?? "../", location.href).href;
}

export class Jellyfin {
  readonly deviceId: string;
  constructor(
    readonly base: string,
    private readonly key: string,
  ) {
    if (!this.base.endsWith("/")) this.base += "/";
    let id = "";
    try {
      id = localStorage.getItem("discmenu.deviceId") ?? "";
      if (!id) localStorage.setItem("discmenu.deviceId", (id = "disc-menu-" + Math.random().toString(36).slice(2)));
    } catch {
      id = "disc-menu";
    }
    this.deviceId = id;
  }

  private auth(): string {
    return `MediaBrowser Client="Disc Menu", Device="Browser", DeviceId="${this.deviceId}", Version="${__PLAYER_VERSION__}", Token="${this.key}"`;
  }

  async get<T>(path: string): Promise<T> {
    const r = await fetch(this.base + path, { headers: { Authorization: this.auth() } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${path.split("?")[0]}`);
    return (await r.json()) as T;
  }

  /** Find the series by name and its season's episodes, keyed by mediaKey. */
  async resolveSeries(name: string, season: number): Promise<{ title: string; items: Map<string, MediaItem> }> {
    const users = await this.get<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }[]>("Users");
    const user = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
    if (!user) throw new Error("no Jellyfin user");
    const all = await this.get<{ Items: { Id: string; Name: string }[] }>(
      `Items?userId=${user.Id}&IncludeItemTypes=Series&Recursive=true`,
    );
    const lc = name.toLowerCase();
    const s =
      all.Items.find((i) => i.Name.toLowerCase() === lc) ??
      all.Items.find((i) => i.Name.toLowerCase().includes(lc.split(" ")[0]));
    if (!s) throw new Error(`series not found: ${name}`);
    const eps = await this.get<{
      Items: { Id: string; Name: string; IndexNumber?: number; MediaSources?: { Id: string; MediaStreams: Stream[] }[] }[];
    }>(`Shows/${s.Id}/Episodes?userId=${user.Id}&season=${season}&Fields=MediaSources,MediaStreams,Path`);
    const items = new Map<string, MediaItem>();
    for (const e of eps.Items) {
      const ms = e.MediaSources?.[0];
      if (e.IndexNumber && ms) items.set(`E${e.IndexNumber}`, { id: e.Id, name: e.Name, mediaSourceId: ms.Id, streams: ms.MediaStreams });
    }
    return { title: s.Name, items };
  }

  streamUrl(item: MediaItem, audio: number | null, sub: number | null, playSessionId: string): string {
    const q = new URLSearchParams({
      MediaSourceId: item.mediaSourceId,
      DeviceId: this.deviceId,
      PlaySessionId: playSessionId,
      ApiKey: this.key,
      VideoCodec: "h264",
      AudioCodec: "aac",
      TranscodingMaxAudioChannels: "2",
      VideoBitrate: "8000000",
      AudioBitrate: "192000",
      SegmentContainer: "ts",
      MinSegments: "1",
      BreakOnNonKeyFrames: "True",
    });
    if (audio !== null) q.set("AudioStreamIndex", String(audio));
    if (sub !== null) {
      q.set("SubtitleStreamIndex", String(sub));
      q.set("SubtitleMethod", "Encode");
    }
    return `${this.base}Videos/${item.id}/master.m3u8?${q}`;
  }

  stopEncoding(playSessionId: string): void {
    const q = new URLSearchParams({ deviceId: this.deviceId, playSessionId });
    fetch(`${this.base}Videos/ActiveEncodings?${q}`, {
      method: "DELETE",
      headers: { Authorization: this.auth() },
    }).catch(() => {});
  }
}

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

  /**
   * The Jellyfin stream indexes a request maps to (null = Jellyfin's default / none). A subtitle is the sidecar
   * file the pack names, else the file's first subtitle stream in the chosen language.
   */
  pick(r: PlayRequest): { item: MediaItem; audio: number | null; sub: number | null } {
    const item = this.items.get(r.media);
    if (!item) throw new Error(`${r.title} isn't in Jellyfin`);
    const audio = r.audioLang3
      ? (item.streams.find((s) => s.Type === "Audio" && s.Language === r.audioLang3)?.Index ?? null)
      : null;
    const subs = item.streams.filter((s) => s.Type === "Subtitle");
    const sub =
      (r.sidecar ? subs.find((s) => s.IsExternal && (s.Path ?? "").endsWith(r.sidecar!)) : undefined) ??
      (r.subLang3 ? subs.find((s) => !s.IsExternal && s.Language === r.subLang3) : undefined);
    return { item, audio, sub: sub?.Index ?? null };
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
