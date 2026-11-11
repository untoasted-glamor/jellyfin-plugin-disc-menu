// The Blu-ray side of the menu player page, for hdmv-1 packs: draws the menu (the menu playlist's background, looped,
// with the IG page's buttons over it in their states) and turns what HdmvVm decides into the page's hand-off, or, on
// the page opened by hand, the stub's playback. The page (player.ts) keeps the sign-in, the overlay, Stats and the
// wait notice, and hands this class the keys while a Blu-ray pack is open.
//
// Audio and subtitles go with a hand-off only when the viewer changed them in the disc's menus, as for a DVD. A
// Blu-ray often sets its streams itself when it starts an episode (an anime disc may set English audio and a signs
// track whatever the player's languages), so the baseline is what the disc picks when the viewer only presses its
// first menu's default button, worked out once with a second VM; a disc whose default button doesn't play anything
// falls back to the DVD rule (the registers at the viewer's first press).
import type { Level } from "./debuglog.js";
import { PlayHandoff, QUEUE_MAX } from "./embed.js";
import { describeHandoff, handoffDetail, handoffFor, handoffReasons, StreamRegs, titleAction } from "./handoff.js";
import { Handoff, HdmvCell, HdmvPack, HdmvVm, MenuState, Status, TICKS } from "./hdmvvm.js";
import { fmt, MediaItem, mediaKey, PlayRequest } from "./playback.js";

export interface BdHost {
  doc: Document;
  stage: HTMLDivElement;
  menuLayer: HTMLDivElement;
  embedded: boolean;
  packUrl(file: string): string;
  watchLoad(el: HTMLImageElement | HTMLMediaElement, file: string): void;
  /** Starts a menu's background video (the browser may hold it back until the viewer presses Start). */
  playVideo(v: HTMLVideoElement): void;
  status(s: string, level?: Level): void;
  /** An event in the log and Stats. */
  event(level: Level, s: string): void;
  /** The VM's trace. */
  trace(s: string): void;
  items(): Map<string, MediaItem>;
  /** "Wait before playing from menu" is on. */
  waitFirst(): boolean;
  /** "S01E03", "S00E01", or the extra's file name. */
  title(cell: HdmvCell): string;
  send(h: PlayHandoff): void;
  hold(h: PlayHandoff): void;
  /** The page opened by hand: the stub shows what plays. */
  show(r: PlayRequest): void;
  stopShow(): void;
  refresh(): void;
}

/** How long a pressed button shows its activated image before its commands run. */
const PRESS_MS = 150;
const PSR2_SHOWN = 0x80000000;

/** PSR 1 and 2 as the hand-off compares them: the stream numbers, and PSR 2's display flag with its number. */
export function streamRegs(vm: HdmvVm): StreamRegs {
  return { audio: vm.psr[1] & 0xff, subp: (vm.psr[2] & (PSR2_SHOWN | 0xfff)) >>> 0, subOn: (vm.psr[2] & PSR2_SHOWN) !== 0 };
}

/** The streams the disc picks itself when the viewer only presses the first menu's default button, or null. */
export function discDefaults(pack: HdmvPack): StreamRegs | null {
  const vm = new HdmvVm(pack);
  let s = vm.start();
  if (s.kind === "menu") s = vm.activate();
  return s.kind === "handoff" ? streamRegs(vm) : null;
}

/** Every image a menu shows, to warm the browser's cache. */
export function menuFiles(pack: HdmvPack): string[] {
  const files = new Set<string>();
  for (const pl of Object.values(pack.playlists)) if (pl.background?.still) files.add(pl.background.still);
  for (const m of Object.values(pack.menus))
    for (const p of m.pages ?? [])
      for (const g of p.bogs)
        for (const b of g.buttons) for (const f of [...b.images.normal, ...b.images.selected, ...b.images.activated]) files.add(f);
  return [...files];
}

export class BdPage {
  vm: HdmvVm;
  /** The viewer pressed a menu button (the disc's auto-action buttons don't count). */
  private pressed = false;
  private baseline: StreamRegs | null;
  private readonly defaults: StreamRegs | null;
  /** The menu playlist whose background is up. */
  private drawn: string | null = null;
  private ig: HTMLDivElement | null = null;
  /** The page whose buttons are drawn, and their pictures by button id. */
  private page = "";
  private readonly imgs = new Map<number, HTMLImageElement>();
  private timer = 0;
  /** On the page opened by hand: the hand-off the stub is showing, and which of its cells. */
  private showing: { h: Handoff; at: number } | null = null;

  constructor(
    readonly pack: HdmvPack,
    private readonly host: BdHost,
  ) {
    this.defaults = discDefaults(pack);
    this.baseline = this.defaults;
    this.vm = this.newVm();
  }

  private newVm(): HdmvVm {
    return new HdmvVm(this.pack, {
      log: (s) => this.host.trace(s),
      unsupported: (f) => this.host.event("warn", `This disc uses ${f}, which the player leaves out`),
    });
  }

  start(): void {
    window.clearTimeout(this.timer);
    this.pressed = false;
    this.baseline = this.defaults;
    this.showing = null;
    this.host.stopShow();
    this.clear();
    this.vm = this.newVm();
    if (this.defaults)
      this.host.trace(`the disc's own streams at its first menu's default button: PSR 1 = ${this.defaults.audio}, ` +
        `PSR 2 = 0x${this.defaults.subp.toString(16)} (${this.defaults.subOn ? "shown" : "hidden"})`);
    this.render(this.vm.start());
  }

  /** What Stats shows for the VM. */
  state(): string[] {
    const vm = this.vm;
    const s = vm.status;
    const where =
      s.kind === "menu"
        ? `menu ${s.menu.key} (playlist ${s.menu.playlist}), page ${s.menu.page.id}, button ${s.menu.selected ?? "none"}`
        : s.kind === "handoff"
          ? `playing playlist ${s.handoff.playlist} from ${fmt(s.handoff.start / TICKS)}`
          : `stopped (${s.why})`;
    const lines = [
      `VM: ${where}`,
      `Title (PSR 4) ${vm.psr[4]}; playlist (PSR 6) ${vm.psr[6]}; IG stream (PSR 0) ${vm.psr[0]}; audio (PSR 1) ${vm.psr[1]}; ` +
        `subtitles (PSR 2) 0x${vm.psr[2].toString(16)}; button (PSR 10) ${vm.psr[10]}, page (PSR 11) ${vm.psr[11]}`,
    ];
    const g = Array.from(vm.gpr).flatMap((v, i) => (v ? [`g${i}=${v}`] : []));
    lines.push(`GPRs not 0: ${g.length ? g.join(" ") : "none"}`);
    if (this.baseline) lines.push(`Streams baseline: PSR 1 ${this.baseline.audio}, PSR 2 0x${this.baseline.subp.toString(16)}` +
      (this.defaults ? " (the disc's own, at its default button)" : " (at the first button press)"));
    return lines;
  }

  get inMenu(): boolean {
    return this.vm.status.kind === "menu";
  }

  // ------------------------------------------------------------------------------------------ keys

  /** A key while the menu shows; false when it isn't one the menu takes. */
  key(k: string): boolean {
    if (this.vm.status.kind !== "menu") return false;
    const dir = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as const)[k as "ArrowUp"];
    if (dir) this.render(this.vm.move(dir));
    else if (k === "Enter" || k === " ") this.press();
    else if (/^[0-9]$/.test(k)) this.render(this.vm.number(Number(k)));
    else return false;
    return true;
  }

  /** The remote's Menu key: the disc's top menu. */
  topMenu(): void {
    window.clearTimeout(this.timer);
    this.host.stopShow();
    this.showing = null;
    this.render(this.vm.topMenu());
  }

  /** The viewer pressed the selected button (a key, a click or a tap). */
  private press(): void {
    const s = this.vm.status;
    if (s.kind !== "menu" || s.menu.selected == null) return;
    const id = s.menu.selected;
    if (!this.pressed) {
      this.pressed = true;
      this.baseline ??= streamRegs(this.vm);
    }
    this.host.event("info", `Button ${id} pressed on page ${s.menu.page.id} of ${s.menu.key}`);
    this.paint(s.menu, id);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(this.vm.activate()), PRESS_MS);
  }

  // ------------------------------------------------------------------------------------------ what the VM decided

  render(s: Status): void {
    this.host.refresh();
    if (s.kind === "menu") {
      if (this.host.menuLayer.hidden) this.host.stopShow(); // back from a title: the stub comes down
      return this.drawMenu(s.menu);
    }
    if (s.kind === "handoff") return this.play(s.handoff);
    this.clear();
    this.host.status(`The disc's navigation stopped (${s.why}). Press Restart.`, "warn");
  }

  /** The handed-off item ended (the page opened by hand), or was skipped: the disc goes on. */
  ended(): void {
    this.showing = null;
    this.render(this.vm.ended());
  }

  /** The stub finished a file: the next cell of a play-all, else the disc goes on. */
  showEnded(): void {
    const sh = this.showing;
    if (sh && sh.at < sh.h.queue.length) {
      sh.at++;
      this.showCell(sh.h, sh.h.queue[sh.at - 1], sh.h.queue[sh.at - 1].offset, sh.at);
      return;
    }
    this.ended();
  }

  /** `n`: which of the play's cells (0 the first, then its queue). */
  private request(h: Handoff, cell: HdmvCell, offset: number, n = 0): PlayRequest {
    return {
      media: mediaKey(cell),
      title: this.host.title(cell),
      offset,
      length: cell.offset + cell.dur,
      audioLang3: h.audio?.lang3 ?? null,
      sidecar: h.pg?.sidecar ?? null,
      subLang3: h.pg?.lang3 ?? null,
      label: n === 0 ? `playlist ${h.playlist} from ${fmt(h.start / TICKS)}` : `playlist ${h.playlist}, ${n + 1} of ${h.queue.length + 1}`,
    };
  }

  private play(h: Handoff): void {
    const items = this.host.items();
    const item = items.get(mediaKey(h.cell));
    const action = titleAction({ embedded: this.host.embedded, mapped: true, inLibrary: !!item, pressed: this.pressed });
    const r = this.request(h, h.cell, h.offset);
    if (action === "missing") {
      this.host.status(`${r.label}: ${r.title} is not in the library, skipped`, "warn");
      return this.later(500, () => this.ended());
    }
    if (action === "intro") {
      this.host.status(`The disc started ${r.title} (${r.label}) before any menu button was pressed: skipped`, "warn");
      return this.later(500, () => this.ended());
    }
    if (action === "show") {
      this.showing = { h, at: 0 };
      return this.showCell(h, h.cell, h.offset);
    }
    const ph = this.handoff(h, item!, r);
    if (this.host.waitFirst()) {
      this.host.status(`Waiting before playing ${r.label} from the menu: ${describeHandoff(ph)}`);
      this.host.hold(ph);
    } else {
      this.host.status(`Handing ${r.label} to Jellyfin's player: ${describeHandoff(ph)}`);
      this.host.send(ph);
    }
  }

  /** The Play command for the cell and the queue after it (the cells the library has). */
  handoff(h: Handoff, item: MediaItem, r: PlayRequest): PlayHandoff {
    const now = streamRegs(this.vm);
    const base = this.baseline ?? now;
    // A register that names no stream here chose nothing (the VM fell back to a language): Jellyfin's choice.
    if (!h.audioSet) now.audio = base.audio;
    if (now.subOn && !h.pgSet) now.subp = base.subp;
    const ph = handoffFor(item, r, now, base);
    const items = this.host.items();
    const queue: string[] = [];
    const missing: string[] = [];
    for (const c of h.queue) {
      const it = items.get(mediaKey(c));
      if (it) queue.push(it.id);
      else missing.push(this.host.title(c));
    }
    if (missing.length) this.host.event("warn", `The play-all goes on without ${missing.join(", ")}: not in the library`);
    if (queue.length) ph.queue = queue.slice(0, QUEUE_MAX);
    this.host.event("info", `It sends: ${handoffDetail(ph, handoffReasons(item, r, now, base))}`);
    return ph;
  }

  private showCell(h: Handoff, cell: HdmvCell, offset: number, n = 0): void {
    this.clear();
    const r = this.request(h, cell, offset, n);
    const item = this.host.items().get(r.media);
    const more = this.showing ? h.queue.length - this.showing.at : 0;
    this.host.status(`Playing ${r.title} from ${fmt(offset)} (${r.label}), audio ${r.audioLang3 ?? "default"}, ` +
      `subtitles ${r.sidecar ?? r.subLang3 ?? "off"}` + (more > 0 ? `, then ${more} more` : "") +
      (item && cell === h.cell ? `. The Disc menu button would hand off ${describeHandoff(this.handoff(h, item, r))}` : ""));
    this.host.show(r);
  }

  private later(ms: number, fn: () => void): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(fn, ms);
  }

  // ------------------------------------------------------------------------------------------ drawing

  /** Takes the menu down. */
  clear(): void {
    this.host.menuLayer.replaceChildren();
    this.host.menuLayer.hidden = true;
    this.drawn = null;
    this.ig = null;
    this.page = "";
    this.imgs.clear();
  }

  private drawMenu(m: MenuState): void {
    const host = this.host;
    const [w, h] = m.menu.size ?? [1920, 1080];
    if (this.drawn !== m.playlist || !this.ig) {
      this.clear();
      host.menuLayer.hidden = false;
      host.stage.style.aspectRatio = `${w} / ${h}`;
      host.stage.style.setProperty("--ar", String(w / h));
      const bg = this.pack.playlists[m.playlist]?.background;
      if (bg?.video) {
        const v = host.doc.createElement("video");
        v.src = host.packUrl(bg.video);
        if (bg.still) v.poster = host.packUrl(bg.still);
        host.watchLoad(v, bg.video);
        v.className = "layer";
        v.playsInline = true;
        // The menu playlist loops on the disc until a button is pressed (its movie object plays it again).
        v.loop = true;
        host.menuLayer.append(v);
        host.playVideo(v);
      } else if (bg?.still) {
        const i = host.doc.createElement("img");
        i.src = host.packUrl(bg.still);
        host.watchLoad(i, bg.still);
        i.className = "layer";
        i.alt = "";
        host.menuLayer.append(i);
      }
      this.ig = host.doc.createElement("div");
      this.ig.className = "ig";
      host.menuLayer.append(this.ig);
      this.drawn = m.playlist;
    }
    this.paint(m, null);
    const n = this.vm.shownButtons().filter((s) => s.image).length;
    host.status(`Menu ${m.key}, page ${m.page.id}: ${n} buttons`);
  }

  /** Draws the page's buttons in their states; `activated` is the one being pressed. */
  private paint(m: MenuState, activated: number | null): void {
    const ig = this.ig;
    if (!ig) return;
    const [w, h] = m.menu.size ?? [1920, 1080];
    const page = `${m.key}.${m.page.id}`;
    if (this.page !== page) {
      ig.replaceChildren();
      this.imgs.clear();
      this.page = page;
    }
    const shown = new Set<number>();
    for (const s of this.vm.shownButtons()) {
      const b = s.button;
      const file = (b.id === activated ? b.images.activated[0] : undefined) ?? s.image;
      if (!file) continue; // a button with no picture: the disc's own logic, nothing to point at
      shown.add(b.id);
      let i = this.imgs.get(b.id);
      if (!i) {
        i = this.button(b.id, b.txt?.join("; ") ?? "", b.x / w, b.y / h, w);
        this.imgs.set(b.id, i);
        ig.append(i);
      }
      i.classList.toggle("on", s.state === "selected");
      if (i.dataset.file !== file) {
        i.dataset.file = file;
        i.src = this.host.packUrl(file);
        this.host.watchLoad(i, file);
      }
    }
    // A button that enable/disable or set_button_page took out of its group.
    for (const [id, i] of this.imgs) if (!shown.has(id)) i.hidden = true;
    for (const id of shown) this.imgs.get(id)!.hidden = false;
  }

  /** One button's picture, positioned on the menu as a share of its size, sized once its image loads. */
  private button(id: number, alt: string, x: number, y: number, w: number): HTMLImageElement {
    const i = this.host.doc.createElement("img");
    i.alt = alt;
    i.className = "igb";
    i.dataset.id = String(id);
    i.style.left = `${(x * 100).toFixed(3)}%`;
    i.style.top = `${(y * 100).toFixed(3)}%`;
    i.style.visibility = "hidden";
    i.addEventListener("load", () => {
      i.style.width = `${((i.naturalWidth / w) * 100).toFixed(3)}%`;
      i.style.visibility = "visible";
    });
    // pointermove, not mouseenter: a pointer resting where a new page draws a button must not steal the selection.
    i.addEventListener("pointermove", () => {
      const s = this.vm.status;
      if (s.kind === "menu" && s.menu.selected !== id) this.render(this.vm.select(id));
    });
    i.addEventListener("click", (e) => {
      e.preventDefault();
      const s = this.vm.status;
      if (s.kind !== "menu") return;
      if (s.menu.selected !== id) {
        this.render(this.vm.select(id));
        const t = this.vm.status;
        if (t.kind !== "menu" || t.menu.selected !== id) return; // an auto-action button already ran
      }
      this.press();
    });
    return i;
  }
}
