// The Blu-ray (HDMV) menu VM for hdmv-1 packs: movie object commands and registers after libbluray's hdmv_vm.c and
// register.c, and the interactive graphics (IG) engine after its graphics_controller.c (pages, button overlap
// groups, selection, neighbours, auto-action buttons, enable and disable). No DOM and no Jellyfin: the player asks
// it what to show and tells it what the viewer pressed.
//
// What a play_pl does (design plan v5, "What the player needs for Blu-ray"): (1) a start time inside a media cell
// hands off one way to the library item, with the cells after it as a queue; (2) else the IG stream PSR 0 picks
// loads an always-on menu, shown over the playlist's background; (3) else the playlist plays through: it is
// skipped, logged, and the movie object goes on at its next command.

export interface HdmvButton {
  id: number;
  numeric: number | null;
  x: number;
  y: number;
  auto: boolean;
  nav: { up: number; down: number; left: number; right: number };
  images: { normal: string[]; selected: string[]; activated: string[] };
  sounds: boolean;
  cmds: string[];
  txt?: string[];
}
export interface HdmvBog {
  default: number | null;
  buttons: HdmvButton[];
}
export interface HdmvPage {
  id: number;
  default_selected: number | null;
  default_activated: number | null;
  effects: boolean;
  bogs: HdmvBog[];
}
export interface HdmvMenu {
  clip: string;
  pid: number;
  model: "always_on" | "popup";
  omitted?: boolean;
  stream_model?: string;
  size?: [number, number];
  timeout?: { composition: number | null; selection: number | null; user: number | null };
  pages?: HdmvPage[];
}
export interface HdmvItem {
  clip: string;
  in: number;
  out: number;
  repeat?: number;
}
export interface HdmvMark {
  type: string;
  item: number;
  time: number;
  at: number | null;
}
export interface HdmvAudio {
  n: number;
  lang3: string;
  codec: string;
  channels: number;
}
export interface HdmvPg {
  n: number;
  lang3: string;
  sidecar?: string;
  bd_events?: number;
  sidecar_events?: number;
}
export interface HdmvPlaylist {
  items: HdmvItem[];
  marks: HdmvMark[];
  streams: { audio: HdmvAudio[]; pg: HdmvPg[]; ig: { n: number; lang3: string }[] };
  menus: Record<string, string>;
  background?: { video: string; still: string };
}
/** Where a playlist time's video lives: an episode (a special is season 0) or an extra, and where in its file. */
export interface HdmvCell {
  episode?: number;
  season?: number;
  extra?: string;
  file: string;
  offset: number;
  dur: number;
}
export interface HdmvObject {
  resume: boolean;
  menu_call_mask: boolean;
  title_search_mask: boolean;
  cmds: string[];
  txt?: string[];
}
export interface HdmvPack {
  schema: "hdmv-1";
  disc: { type: string; name: string; season?: number; job?: string; size?: [number, number]; menu_languages?: string[] };
  psr: Record<string, number>;
  index: { first_play: number; top_menu: number; titles: ({ n: number; object: number } | { n: number; bdj: true })[] };
  objects: Record<string, HdmvObject>;
  playlists: Record<string, HdmvPlaylist>;
  menus: Record<string, HdmvMenu>;
  media: Record<string, { cells: Record<string, HdmvCell> }>;
}

/** 45 kHz ticks, the playlist's own time unit. */
export const TICKS = 45000;

/**
 * libbluray's start values (register.c bd_psr_init) with a player set to English (PSR 16-18 "eng"), the US (PSR 19)
 * and region A (PSR 20). D2's first play tests PSR 4 for 0xFFFF to tell a start from a resume.
 */
export const PSR_INIT: Readonly<Record<number, number>> = {
  0: 1, 1: 0xff, 2: 0x0fff0fff, 3: 1, 4: 0xffff, 5: 0xffff, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0xffff, 11: 0, 12: 0xff,
  13: 0xff, 14: 0xffff, 15: 0xffff, 16: 0x656e67, 17: 0x656e67, 18: 0x656e67, 19: 0x5553, 20: 0x1, 21: 0xffff,
  29: 0x03, 30: 0x1ffff, 31: 0x080200, 36: 0xffff, 37: 0xffff, 42: 0xffff, 44: 0xff,
};
export const STEP_LIMIT = 50000;
const NONE = 0xffff;
/** How many auto-action and default-activated buttons in a row are followed before it is called a loop. */
const AUTO_DEPTH = 64;

/** A three-letter language as PSR 16-18 hold it. */
export const langCode = (lang3: string) =>
  lang3.length === 3 ? (lang3.charCodeAt(0) << 16) | (lang3.charCodeAt(1) << 8) | lang3.charCodeAt(2) : 0xffffff;

// ---------------------------------------------------------------------------------------------- commands

export interface Cmd {
  opCnt: number;
  grp: number;
  sub: number;
  imm1: boolean;
  imm2: boolean;
  br: number;
  cmp: number;
  set: number;
  dst: number;
  src: number;
}

export function decode(hex: string): Cmd {
  const n = (o: number) => parseInt(hex.slice(o * 2, o * 2 + 8), 16) >>> 0;
  const w = n(0);
  return {
    opCnt: w >>> 29,
    grp: (w >>> 27) & 3,
    sub: (w >>> 24) & 7,
    imm1: ((w >>> 23) & 1) === 1,
    imm2: ((w >>> 22) & 1) === 1,
    br: (w >>> 16) & 0xf,
    cmp: (w >>> 8) & 0xf,
    set: w & 0x1f,
    dst: n(4),
    src: n(8),
  };
}

const compare = (op: number, a: number, b: number): boolean => {
  switch (op) {
    case 1: return (a & b) >>> 0 === b;
    case 2: return a === b;
    case 3: return a !== b;
    case 4: return a >= b;
    case 5: return a > b;
    case 6: return a <= b;
    case 7: return a < b;
    default: return false;
  }
};

/** What running commands came to. */
type Event =
  | { kind: "play"; playlist: number; item: number | null; mark: number | null }
  | { kind: "link"; item: number | null; mark: number | null }
  | { kind: "page"; page: number | null; button: number | null }
  | { kind: "jump"; object: number; call: boolean }
  | { kind: "end"; why: string };

// ---------------------------------------------------------------------------------------------- outcomes

/** A button as the renderer draws it: its image for the state it is in. */
export interface ShownButton {
  button: HdmvButton;
  state: "normal" | "selected" | "activated";
  image: string | null;
}

export interface MenuState {
  playlist: string;
  key: string;
  menu: HdmvMenu;
  page: HdmvPage;
  selected: number | null;
  /** The button shown in each overlap group (by group index), or null when the group shows none. */
  enabled: (number | null)[];
  /** The selected auto-action button has run (libbluray's auto_action_triggered). */
  autoDone?: boolean;
  /** enable_button moved the selection to this button; it takes effect when the commands end. */
  pendingSelect?: number;
}

export interface Handoff {
  playlist: string;
  /** Where the play starts, in playlist ticks. */
  start: number;
  cell: HdmvCell;
  /** Seconds into the cell's file. */
  offset: number;
  /** The cells after it in the playlist (a play-all), in order. */
  queue: HdmvCell[];
  audio: HdmvAudio | null;
  /** The chosen subtitle stream when PSR 2's display flag is set, else null (off). */
  pg: HdmvPg | null;
  /** PSR 1 and PSR 2 name streams this playlist has (else audio and pg are the language fallback). */
  audioSet: boolean;
  pgSet: boolean;
}

export type Status =
  | { kind: "menu"; menu: MenuState }
  | { kind: "handoff"; handoff: Handoff }
  | { kind: "stopped"; why: string };

export interface HdmvOptions {
  log?: (s: string) => void;
  /** Called once per feature the pack uses that the player leaves out (pop-ups, sounds, effects, BD-J, ...). */
  unsupported?: (feature: string) => void;
  rnd?: () => number;
  /** The viewer's audio and subtitle languages (PSR 16, 17; 18 follows audio), three letters. */
  audioLang?: string | null;
  subtitleLang?: string | null;
}

export class HdmvVm {
  readonly gpr = new Uint32Array(4096);
  readonly psr = new Uint32Array(128);
  status: Status = { kind: "stopped", why: "not started" };
  private readonly log: (s: string) => void;
  private readonly unsupportedCb: (feature: string) => void;
  private readonly seen = new Set<string>();
  private readonly rnd: () => number;
  private steps = 0;
  /** The movie object waiting for its playlist to end, and where it goes on. */
  private suspended: { object: number; pc: number } | null = null;
  private readonly stack: { object: number; pc: number }[] = [];

  constructor(
    readonly pack: HdmvPack,
    opts: HdmvOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.unsupportedCb = opts.unsupported ?? (() => {});
    this.rnd = opts.rnd ?? Math.random;
    for (const [k, v] of Object.entries(PSR_INIT)) this.psr[Number(k)] = v;
    if (opts.audioLang) this.psr[16] = this.psr[18] = langCode(opts.audioLang);
    if (opts.subtitleLang) this.psr[17] = langCode(opts.subtitleLang);
    for (const [k, v] of Object.entries(pack.psr ?? {})) this.psr[Number(k)] = v >>> 0;
  }

  // ------------------------------------------------------------------------------------------ public API

  /** Run first play until it shows a menu, hands off or stops. */
  start(): Status {
    this.log("start: first play");
    this.steps = 0;
    return this.settle(this.runObject(this.pack.index.first_play, 0));
  }

  /** The remote's top menu key: the index's top menu object, unless the playing object masks menu calls. */
  topMenu(): Status {
    if (this.suspended && this.pack.objects[String(this.suspended.object)]?.menu_call_mask) {
      this.log("top menu: masked by the playing object");
      return this.status;
    }
    this.log("top menu");
    this.steps = 0;
    this.stack.length = 0;
    this.psr[4] = 0;
    return this.settle(this.runObject(this.pack.index.top_menu, 0));
  }

  /**
   * The handed-off library item finished (or the viewer stopped it and asked for the menu back): the playlist that
   * started it has ended, so the movie object that played it goes on, as a disc's does.
   */
  ended(): Status {
    this.log("playlist ended");
    this.steps = 0;
    if (!this.suspended) return (this.status = { kind: "stopped", why: "nothing to go on with" });
    return this.resumeSuspended();
  }

  /** The menu's buttons as they are drawn now: the enabled button of each group, in its state. */
  shownButtons(): ShownButton[] {
    if (this.status.kind !== "menu") return [];
    const m = this.status.menu;
    const out: ShownButton[] = [];
    m.page.bogs.forEach((g, i) => {
      const id = m.enabled[i];
      const b = id == null ? undefined : g.buttons.find((x) => x.id === id);
      if (!b) return;
      const state = b.id === m.selected ? "selected" : "normal";
      const image = (state === "selected" ? b.images.selected[0] : undefined) ?? b.images.normal[0] ?? null;
      out.push({ button: b, state, image });
    });
    return out;
  }

  /** Arrow keys: the selected button's neighbour, if it is shown; an auto-action button runs at once. */
  move(dir: "up" | "down" | "left" | "right"): Status {
    if (this.status.kind !== "menu") return this.status;
    const m = this.status.menu;
    const cur = this.button(m, m.selected);
    if (!cur) return this.status;
    const to = cur.nav[dir];
    if (to === cur.id || !this.isEnabled(m, to)) return this.status;
    this.selectButton(m, to);
    this.steps = 0;
    return this.render(m, 0);
  }

  /** Select a shown button (a pointer over it); an auto-action button runs at once. */
  select(id: number | null): Status {
    if (this.status.kind !== "menu" || id == null) return this.status;
    const m = this.status.menu;
    if (!this.isEnabled(m, id) || id === m.selected) return this.status;
    this.selectButton(m, id);
    this.steps = 0;
    return this.render(m, 0);
  }

  /** OK / Enter: run the selected button's commands. */
  activate(): Status {
    if (this.status.kind !== "menu") return this.status;
    const m = this.status.menu;
    const b = this.button(m, m.selected);
    if (!b) return this.status;
    this.steps = 0;
    return this.press(m, b, 0);
  }

  /** A number key selects the shown button with that number (libbluray: it runs only if it is auto-action). */
  number(n: number): Status {
    if (this.status.kind !== "menu") return this.status;
    const hit = this.shownButtons().find((s) => s.button.numeric === n);
    return hit ? this.select(hit.button.id) : this.status;
  }

  /** Where a play of `playlist` from `start` ticks lands: its media cell and the cells after it, or null. */
  cellAt(playlist: string, start: number): { key: number; cell: HdmvCell; queue: HdmvCell[] } | null {
    const cells = this.pack.media[playlist]?.cells;
    if (!cells) return null;
    const keys = Object.keys(cells).map(Number).sort((a, b) => a - b);
    let hit = -1;
    for (let i = 0; i < keys.length; i++) if (keys[i] <= start) hit = i;
    if (hit < 0) return null;
    const cell = cells[String(keys[hit])];
    if (start >= keys[hit] + Math.round(cell.dur * TICKS)) return null;
    return { key: keys[hit], cell, queue: keys.slice(hit + 1).map((k) => cells[String(k)]) };
  }

  // ------------------------------------------------------------------------------------------ playlists

  /** Ticks from the playlist's start at which play item `item` starts (repeats counted). */
  itemStart(pl: HdmvPlaylist, item: number): number {
    let n = 0;
    let t = 0;
    for (const it of pl.items) {
      const reps = it.repeat ?? 1;
      for (let r = 0; r < reps; r++, n++) {
        if (n === item) return t;
        t += it.out - it.in;
      }
    }
    return t;
  }

  private play(ev: { playlist: number; item: number | null; mark: number | null }): Status | null {
    const name = String(ev.playlist).padStart(5, "0");
    const pl = this.pack.playlists[name];
    this.psr[6] = ev.playlist;
    if (!pl) {
      this.log(`play_pl ${name}: not in the pack; plays through`);
      return null;
    }
    let start = 0;
    if (ev.mark != null) {
      const mk = pl.marks[ev.mark];
      start = mk?.at ?? 0;
      if (!mk) this.log(`play_pl ${name} mark ${ev.mark}: no such mark, from the start`);
    } else if (ev.item != null) start = this.itemStart(pl, ev.item);
    return this.decide(name, pl, start);
  }

  /** play_pl's three outcomes, in order: a handoff, a menu, playing through (null). */
  private decide(name: string, pl: HdmvPlaylist, start: number): Status | null {
    const hit = this.cellAt(name, start);
    if (hit) {
      const handoff: Handoff = {
        playlist: name,
        start,
        cell: hit.cell,
        offset: hit.cell.offset + (start - hit.key) / TICKS,
        queue: hit.queue,
        audio: this.audioStream(pl),
        pg: this.pgStream(pl),
        audioSet: pl.streams.audio.some((a) => a.n === (this.psr[1] & 0xff)),
        pgSet: pl.streams.pg.some((p) => p.n === (this.psr[2] & 0xfff)),
      };
      this.log(`play_pl ${name} @${(start / TICKS).toFixed(2)}s: hands off ${describeCell(hit.cell)}` +
        (hit.queue.length ? `, then ${hit.queue.length} more` : ""));
      this.status = { kind: "handoff", handoff };
      return this.status;
    }
    const ig = this.psr[0] & 0xff || 1;
    const key = pl.menus[String(ig)] ?? pl.menus["1"];
    const menu = key ? this.pack.menus[key] : undefined;
    if (menu && menu.model === "always_on" && menu.pages?.length) {
      this.log(`play_pl ${name}: shows menu ${key}`);
      return this.showMenu(name, key, menu);
    }
    if (menu?.model === "popup") this.unsupported(`pop-up menu ${key}`);
    const secs = pl.items.reduce((s, it) => s + ((it.out - it.in) * (it.repeat ?? 1)) / TICKS, 0);
    this.log(`play_pl ${name} (${secs.toFixed(1)}s): no media and no menu, plays through`);
    return null;
  }

  /** PSR 1's audio stream; when it names none in this playlist, the viewer's language (PSR 16), else the first. */
  private audioStream(pl: HdmvPlaylist): HdmvAudio | null {
    const n = this.psr[1] & 0xff;
    const all = pl.streams.audio;
    return all.find((a) => a.n === n) ?? all.find((a) => langCode(a.lang3) === this.psr[16]) ?? all[0] ?? null;
  }

  /** PSR 2's subtitles when its display flag is set (else off); an unknown number falls back to PSR 17's language. */
  private pgStream(pl: HdmvPlaylist): HdmvPg | null {
    if (!(this.psr[2] & 0x80000000)) return null;
    const n = this.psr[2] & 0xfff;
    const all = pl.streams.pg;
    return all.find((p) => p.n === n) ?? all.find((p) => langCode(p.lang3) === this.psr[17]) ?? all[0] ?? null;
  }

  // ------------------------------------------------------------------------------------------ menus
  // After libbluray's graphics_controller.c: _select_page, _find_selected_button_id, _render_page's auto-action,
  // _set_button_page, _enable_button and _update_selected_button.

  private showMenu(playlist: string, key: string, menu: HdmvMenu): Status {
    if (menu.timeout?.user || menu.timeout?.selection) this.unsupported("menu timeouts");
    const page = menu.pages!.find((p) => p.id === 0) ?? menu.pages![0];
    const m: MenuState = { playlist, key, menu, page, selected: null, enabled: [] };
    this.status = { kind: "menu", menu: m };
    this.selectPage(m, page);
    return this.render(m, 0);
  }

  /** A new page (PSR 11): each group shows its default button, and a button is selected (PSR 10). */
  private selectPage(m: MenuState, page: HdmvPage): void {
    m.page = page;
    this.psr[11] = page.id;
    m.enabled = page.bogs.map((g) => (g.default != null && g.buttons.some((b) => b.id === g.default) ? g.default : null));
    if (page.effects) this.unsupported("page effects");
    if (page.default_activated != null) this.unsupported("default-activated buttons");
    for (const g of page.bogs)
      for (const b of g.buttons) {
        if (b.sounds) this.unsupported("button sounds");
        if (b.images.normal.length > 1 || b.images.selected.length > 1) this.unsupported("animated buttons");
      }
    this.selectButton(m, this.findSelected(m));
  }

  /** The page's default button, else PSR 10, else the first shown button (BD spec 5.9.8.3, as libbluray runs it). */
  private findSelected(m: MenuState): number | null {
    const d = m.page.default_selected;
    if (d != null && this.isEnabled(m, d)) return d;
    if (this.isEnabled(m, this.psr[10])) return this.psr[10];
    return m.enabled.find((id) => id != null) ?? null;
  }

  private selectButton(m: MenuState, id: number | null): void {
    m.selected = id;
    this.psr[10] = id ?? NONE;
    m.autoDone = false;
  }

  /** Drawing the page runs the selected button if it is auto-action, once per selection. */
  private render(m: MenuState, depth: number): Status {
    const b = this.button(m, m.selected);
    if (!b?.auto || m.autoDone) return this.status;
    m.autoDone = true;
    if (depth >= AUTO_DEPTH) {
      this.log("auto-action buttons loop; stopped following them");
      return this.status;
    }
    return this.press(m, b, depth + 1);
  }

  private button(m: MenuState, id: number | null): HdmvButton | undefined {
    if (id == null) return undefined;
    for (const g of m.page.bogs) {
      const b = g.buttons.find((x) => x.id === id);
      if (b) return b;
    }
    return undefined;
  }

  private group(m: MenuState, id: number): number {
    return m.page.bogs.findIndex((g) => g.buttons.some((b) => b.id === id));
  }

  private isEnabled(m: MenuState, id: number | null | undefined): boolean {
    if (id == null || id === NONE) return false;
    return m.enabled.includes(id);
  }

  /** enable_button / disable_button from a button's commands. */
  private setEnabled(m: MenuState, id: number, on: boolean): void {
    const g = this.group(m, id);
    if (g < 0) return;
    if (on) {
      // The selected button's group switching to another button moves the selection to it (when the commands end).
      if (m.enabled[g] != null && m.enabled[g] === m.selected) m.pendingSelect = id;
      m.enabled[g] = id;
    } else {
      if (m.enabled[g] === id) m.enabled[g] = null;
      if (m.selected === id) {
        m.selected = null;
        this.psr[10] = NONE;
      }
    }
  }

  /** set_button_page from a button's commands (they stop there). */
  private setButtonPage(m: MenuState, page: number | null, button: number | null): void {
    if (page == null && button == null) return;
    if (page != null) {
      if (page === m.page.id) return; // the current page: the whole command is ignored
      const p = m.menu.pages!.find((x) => x.id === page);
      if (!p) return;
      this.selectPage(m, p);
    } else if (button != null && (this.group(m, button) < 0 || button === m.selected)) return;
    if (button != null) {
      const g = this.group(m, button);
      if (g < 0) return;
      m.enabled[g] = button;
      this.selectButton(m, button);
    }
  }

  /** Run a button's commands and act on what they come to. */
  private press(m: MenuState, b: HdmvButton, depth: number): Status {
    this.log(`button ${b.id}` + (b.txt?.length ? `: ${b.txt.join("; ")}` : ""));
    const ev = this.run(b.cmds, null, 0);
    if (this.status.kind !== "menu" || this.status.menu !== m) return this.status; // a command already left the menu
    switch (ev.kind) {
      case "page":
        this.setButtonPage(m, ev.page, ev.button);
        break;
      case "play": {
        const s = this.play(ev);
        if (s) return s;
        // Played through: the movie object waiting for the menu's playlist goes on.
        return this.resumeSuspended();
      }
      case "link": {
        // A jump inside the menu's own playlist: only a media cell there changes what is shown.
        const pl = this.pack.playlists[m.playlist];
        const start = ev.mark != null ? (pl.marks[ev.mark]?.at ?? 0) : this.itemStart(pl, ev.item ?? 0);
        if (this.cellAt(m.playlist, start)) return this.decide(m.playlist, pl, start) ?? this.status;
        break;
      }
      case "jump":
        // A button runs in the menu object's place: a call comes back to where that object waits, a jump doesn't.
        if (ev.call && this.suspended) this.stack.push(this.suspended);
        else if (!ev.call) this.stack.length = 0;
        return this.settle(this.runObject(ev.object, 0));
      case "end":
        if (ev.why === "resume") {
          const back = this.stack.pop();
          if (back) return this.settle(this.runObject(back.object, back.pc));
        }
        break;
    }
    // The commands ended in the menu (IG_END): settle the selection, then draw (which may run an auto-action).
    if (m.pendingSelect != null) {
      this.selectButton(m, m.pendingSelect);
      m.pendingSelect = undefined;
    } else if (m.selected == null) this.selectButton(m, this.findSelected(m));
    return this.render(m, depth);
  }

  private resumeSuspended(): Status {
    const s = this.suspended;
    if (!s) return this.status;
    return this.settle(this.runObject(s.object, s.pc));
  }

  // ------------------------------------------------------------------------------------------ movie objects

  /**
   * Run movie objects from `object` at `pc` until a play_pl shows a menu or hands off, or they stop. Playlists that
   * play through return to the object.
   */
  private runObject(object: number, pc: number): Status | Event {
    for (;;) {
      const obj = this.pack.objects[String(object)];
      if (!obj) return { kind: "end", why: `no movie object ${object}` };
      const ev = this.run(obj.cmds, object, pc);
      if (ev.kind === "play" && "next" in ev) {
        const at = ev as Event & { next: number };
        this.suspended = { object, pc: at.next };
        const s = this.play(ev);
        if (s) return s;
        pc = at.next;
        continue;
      }
      if (ev.kind === "jump") {
        if (ev.call) this.stack.push({ object, pc: (ev as Event & { next: number }).next });
        else this.stack.length = 0;
        object = ev.object;
        pc = 0;
        continue;
      }
      if (ev.kind === "end" && ev.why === "resume") {
        const back = this.stack.pop();
        if (!back) return { kind: "end", why: "resume with nothing to resume" };
        object = back.object;
        pc = back.pc;
        continue;
      }
      return ev;
    }
  }

  private settle(r: Status | Event): Status {
    if ("kind" in r && (r.kind === "menu" || r.kind === "handoff" || r.kind === "stopped")) return r as Status;
    const ev = r as Event;
    if (ev.kind === "end") {
      this.log(`stopped: ${ev.why}`);
      this.status = { kind: "stopped", why: ev.why };
    }
    return this.status;
  }

  private titleObject(n: number): number | null {
    if (n === 0) {
      this.psr[4] = 0;
      return this.pack.index.top_menu;
    }
    const t = this.pack.index.titles.find((x) => x.n === n);
    if (!t) return null;
    if ("bdj" in t) {
      this.unsupported(`BD-J title ${n}`);
      return null;
    }
    this.psr[4] = n;
    return t.object;
  }

  private val(v: number, imm: boolean): number {
    if (imm) return v >>> 0;
    return v & 0x80000000 ? this.psr[v & 0x7f] : this.gpr[v & 0xfff];
  }

  private put(v: number, x: number): void {
    if (!(v & 0x80000000)) this.gpr[v & 0xfff] = x >>> 0;
  }

  /**
   * Run commands from `pc`. `object` is the movie object they belong to, or null for a button's commands, which
   * return a page change instead of applying it.
   */
  private run(hexes: string[], object: number | null, pc: number): Event | (Event & { next: number }) {
    const cmds = hexes.map(decode);
    let skip = false;
    while (pc < cmds.length) {
      if (++this.steps > STEP_LIMIT) return { kind: "end", why: "step limit" };
      const c = cmds[pc++];
      if (skip) {
        skip = false;
        continue;
      }
      const a = c.opCnt >= 1 ? this.val(c.dst, c.imm1) : 0;
      const b = c.opCnt >= 2 ? this.val(c.src, c.imm2) : 0;
      if (c.grp === 0) {
        if (c.sub === 0) {
          if (c.br === 0) continue; // nop
          if (c.br === 1) {
            pc = a; // goto
            continue;
          }
          if (c.br === 2) return { kind: "end", why: "break" };
        } else if (c.sub === 1) {
          if (c.br === 0 || c.br === 2) return { kind: "jump", object: a, call: c.br === 2, next: pc };
          if (c.br === 1 || c.br === 3) {
            const o = this.titleObject(a);
            if (o == null) return { kind: "end", why: `title ${a} can't be played` };
            return { kind: "jump", object: o, call: c.br === 3, next: pc };
          }
          if (c.br === 4) return { kind: "end", why: "resume" };
        } else if (c.sub === 2) {
          if (c.br <= 2)
            return { kind: "play", playlist: a, item: c.br === 1 ? b : null, mark: c.br === 2 ? b : null, next: pc };
          if (c.br === 3) continue; // terminate_pl
          if (c.br === 4 || c.br === 5) return { kind: "link", item: c.br === 4 ? a : null, mark: c.br === 5 ? a : null };
        }
        return { kind: "end", why: `unknown branch ${c.sub}/${c.br}` };
      }
      if (c.grp === 1) {
        skip = !compare(c.cmp, a, b);
        continue;
      }
      if (c.grp === 2 && c.sub === 0) {
        this.setOp(c, a, b);
        continue;
      }
      if (c.grp === 2 && c.sub === 1) {
        const ev = this.setSystem(c, object);
        if (ev) return ev;
        continue;
      }
      return { kind: "end", why: `unknown command group ${c.grp}` };
    }
    return { kind: "end", why: object == null ? "button done" : `object ${object} ran off its end` };
  }

  private setOp(c: Cmd, a: number, b: number): void {
    switch (c.set) {
      case 1: this.put(c.dst, b); break;
      case 2: // swap
        this.put(c.dst, b);
        if (!c.imm2) this.put(c.src, a);
        break;
      case 3: this.put(c.dst, a + b); break;
      case 4: this.put(c.dst, a > b ? a - b : 0); break;
      case 5: this.put(c.dst, Math.imul(a, b)); break;
      case 6: this.put(c.dst, b ? Math.floor(a / b) : 0xffffffff); break;
      case 7: this.put(c.dst, b ? a % b : 0xffffffff); break;
      case 8: this.put(c.dst, b ? 1 + Math.floor(this.rnd() * b) : 0); break; // rnd: 1..b
      case 9: this.put(c.dst, a & b); break;
      case 10: this.put(c.dst, a | b); break;
      case 11: this.put(c.dst, a ^ b); break;
      case 12: this.put(c.dst, a | (1 << (b & 31))); break;
      case 13: this.put(c.dst, a & ~(1 << (b & 31))); break;
      case 14: this.put(c.dst, b > 31 ? 0 : a << b); break;
      case 15: this.put(c.dst, b > 31 ? 0 : a >>> b); break;
    }
  }

  private setSystem(c: Cmd, object: number | null): Event | null {
    const { dst, src } = c;
    // A register operand keeps its flag bits; the numbers come from the GPRs it names.
    const reg = (v: number, imm: boolean, mask: number) => (imm ? v : this.gpr[v & 0xfff]) & mask;
    switch (c.set) {
      case 1: // set_stream
      case 11:
        if (dst & 0x80000000) this.psr[1] = reg(dst >>> 16, c.imm1, 0xfff);
        if (dst & 0x8000)
          this.psr[2] = ((this.psr[2] & 0x7ffff000) | reg(dst, c.imm1, 0xfff) | (dst & 0x4000 ? 0x80000000 : 0)) >>> 0;
        if (src & 0x80000000) this.psr[0] = reg(src >>> 16, c.imm2, 0xfff);
        if (src & 0x8000) this.psr[3] = reg(src, c.imm2, 0xfff);
        return null;
      case 3: { // set_button_page
        const button = dst & 0x80000000 ? reg(dst, c.imm1, 0xffff) : null;
        const page = src & 0x80000000 ? reg(src, c.imm2, 0xff) : null;
        // A button's commands hand it to the menu and stop; a movie object's only set PSR 10 and 11.
        if (object == null) return { kind: "page", page, button };
        if (button != null) this.psr[10] = button;
        if (page != null) this.psr[11] = page;
        return null;
      }
      case 4: // enable_button
      case 5: { // disable_button
        // Only a button's commands can (hdmv_vm.c: "not valid in movie objects").
        if (object == null && this.status.kind === "menu")
          this.setEnabled(this.status.menu, this.val(dst, c.imm1) & 0xffff, c.set === 4);
        return null;
      }
      case 7: // popup_off
        return null;
      case 2: // set_nv_timer
        this.unsupported("navigation timers");
        return null;
      default:
        return null; // still on/off, secondary streams, output mode: nothing a menu shows
    }
  }

  private unsupported(feature: string): void {
    if (this.seen.has(feature)) return;
    this.seen.add(feature);
    this.log(`not supported: ${feature}`);
    this.unsupportedCb(feature);
  }
}

export function describeCell(c: HdmvCell): string {
  if (c.extra) return c.extra;
  const s = c.season != null ? `S${String(c.season).padStart(2, "0")}` : "";
  return `${s}E${String(c.episode ?? 0).padStart(2, "0")} (${c.file})`;
}
