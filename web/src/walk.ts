// The walk back end (plan v3, P13): run a pack's menus with no viewer and list what every button does. ARM runs it
// under Node on a menu pack built with no media map, to learn which disc title each menu button plays and so name
// the titles from the menu's labels. No DOM and no Jellyfin.
//
// Blu-ray: every playlist that shows no always-on menu gets one stand-in media cell covering all of it, so a play_pl
// of it hands off and the walk can read the playlist and start time. First play's hand-offs (logos, warnings) are
// recorded and ended until a menu shows. From that menu, every page the disc can reach is visited, breadth first,
// by replaying the button presses that got there on a fresh VM; on each, every shown button is pressed on its own
// replay. Once per menu language asked for (PSR 16-18), since some discs show other pages per language.
//
// DVD: the same breadth-first walk over the DvdVm; a button that lands in a title domain plays that title (title
// number and chapter, and the title set's PGC and cell).

import { DvdVm, type ButtonJson, type Pack as DvdPack } from "./dvdvm";
import { HdmvVm, TICKS, type HdmvPack, type Status } from "./hdmvvm";

/** What one button press led to. */
export type Outcome =
  | { kind: "plays"; playlist: string; start: number; mark: number | null; seconds: number }
  | { kind: "plays_title"; title: number; chapter: number; vts: number; pgc: number; cell: number }
  | { kind: "menu"; at: string }
  | { kind: "stopped"; why: string };

export interface WalkButton {
  id: number;
  /** Top-left at the menu's size, and the size of the image drawn for it (0 when it has none). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The image the button is drawn with in its normal state, or null when it is drawn with none (hidden logic). */
  image: string | null;
  outcome: Outcome;
}

export interface WalkPage {
  /** Blu-ray `<menu key> p<page>`, DVD the VM's `where()`. */
  at: string;
  /** Blu-ray: the menu key, the page id and the playlist that shows it. DVD: the menu cell. */
  menu: string;
  page: number;
  playlist?: string;
  language: string;
  /** Button ids (DVD button numbers) pressed from the first menu to get here. */
  path: number[];
  buttons: WalkButton[];
}

export interface WalkResult {
  schema: "walk-1";
  disc: "bd" | "dvd";
  /** What first play hands off before the first menu (Blu-ray), or the first menu's place. */
  first_play: Outcome[];
  pages: WalkPage[];
  /** Pages not visited because the limit was hit. */
  truncated: boolean;
  unsupported: string[];
}

export interface WalkOptions {
  /** Three-letter menu languages to walk (default: the pack's menu languages, else "eng"). */
  languages?: string[];
  /** Pages per language (default 200). */
  maxPages?: number;
}

const FIRST_PLAY_LIMIT = 50;

/** The pack with a stand-in cell on every playlist that shows no always-on menu. */
export function walkPack(pack: HdmvPack): HdmvPack {
  const media: HdmvPack["media"] = {};
  for (const [name, pl] of Object.entries(pack.playlists)) {
    const shows = Object.values(pl.menus).some((k) => {
      const m = pack.menus[k];
      return m && m.model === "always_on" && !!m.pages?.length;
    });
    if (shows) continue;
    const ticks = pl.items.reduce((s, it) => s + (it.out - it.in) * (it.repeat ?? 1), 0);
    media[name] = { cells: { "0": { file: `walk:${name}`, offset: 0, dur: ticks / TICKS + 1 } } };
  }
  return { ...pack, media };
}

function hdmvOutcome(pack: HdmvPack, s: Status): Outcome {
  if (s.kind === "menu") return { kind: "menu", at: `${s.menu.key} p${s.menu.page.id}` };
  if (s.kind === "stopped") return { kind: "stopped", why: s.why };
  const h = s.handoff;
  const pl = pack.playlists[h.playlist];
  const mark = pl?.marks.findIndex((m) => m.at === h.start) ?? -1;
  return { kind: "plays", playlist: h.playlist, start: h.start, mark: mark >= 0 ? mark : null, seconds: h.start / TICKS };
}

function walkHdmv(source: HdmvPack, opts: WalkOptions): WalkResult {
  const pack = walkPack(source);
  const langs = opts.languages?.length ? opts.languages : source.disc.menu_languages?.length ? source.disc.menu_languages : ["eng"];
  const maxPages = opts.maxPages ?? 200;
  const unsupported = new Set<string>();
  const result: WalkResult = { schema: "walk-1", disc: "bd", first_play: [], pages: [], truncated: false, unsupported: [] };
  const seen = new Set<string>();

  for (const lang of [...new Set(langs)]) {
    const fresh = (): HdmvVm => {
      const vm = new HdmvVm(pack, { audioLang: lang, subtitleLang: lang, rnd: () => 0, unsupported: (f) => unsupported.add(f) });
      let s = vm.start();
      for (let i = 0; i < FIRST_PLAY_LIMIT && s.kind === "handoff"; i++) s = vm.ended();
      return vm;
    };
    const replay = (path: number[]): HdmvVm => {
      const vm = fresh();
      for (const id of path) {
        vm.select(id);
        const s = vm.activate();
        if (s.kind !== "menu") break;
      }
      return vm;
    };
    if (!result.first_play.length) {
      const vm = new HdmvVm(pack, { audioLang: lang, subtitleLang: lang, rnd: () => 0 });
      let s = vm.start();
      for (let i = 0; i < FIRST_PLAY_LIMIT && s.kind === "handoff"; i++) {
        result.first_play.push(hdmvOutcome(pack, s));
        s = vm.ended();
      }
      result.first_play.push(hdmvOutcome(pack, s));
    }
    const queue: number[][] = [[]];
    let pages = 0;
    while (queue.length) {
      const path = queue.shift()!;
      const vm = replay(path);
      if (vm.status.kind !== "menu") continue;
      const m = vm.status.menu;
      const at = `${m.key} p${m.page.id}`;
      // A page already walked in another language counts once, unless its buttons differ.
      const shown = vm.shownButtons();
      const sig = `${at}|${shown.map((b) => `${b.button.id}:${b.button.images.normal[0] ?? ""}`).join(",")}`;
      if (seen.has(sig)) continue;
      if (pages >= maxPages) {
        result.truncated = true;
        break;
      }
      seen.add(sig);
      pages++;
      const page: WalkPage = { at, menu: m.key, page: m.page.id, playlist: m.playlist, language: lang, path, buttons: [] };
      for (const b of shown) {
        const w = replay(path);
        // An auto-action button runs as soon as it is selected; any other runs on OK.
        const selected = w.select(b.button.id);
        const s = b.button.auto ? selected : w.activate();
        const outcome = hdmvOutcome(pack, s);
        if (outcome.kind === "menu" && outcome.at !== at) queue.push([...path, b.button.id]);
        page.buttons.push({
          id: b.button.id,
          x: b.button.x,
          y: b.button.y,
          w: 0,
          h: 0,
          image: b.button.images.normal[0] ?? b.button.images.selected[0] ?? null,
          outcome,
        });
      }
      result.pages.push(page);
    }
  }
  result.unsupported = [...unsupported].sort();
  return result;
}

// ------------------------------------------------------------------------------------------------ DVD

function settleDvd(vm: DvdVm): void {
  for (let i = 0; i < 2000; i++) {
    if (vm.stopped) return;
    if (vm.state.domain === "VTS") return;
    const c = vm.cell;
    if (!c || (c.menu && c.menu.buttons.length) || c.still === 255) return;
    vm.cellEnded();
  }
}

function dvdOutcome(vm: DvdVm): Outcome {
  if (vm.stopped) return { kind: "stopped", why: "stopped" };
  if (vm.state.domain === "VTS") {
    return { kind: "plays_title", title: vm.sprm[4], chapter: vm.sprm[7], vts: vm.state.vtsN, pgc: vm.state.pgcN, cell: vm.state.cellN };
  }
  const c = vm.cell;
  if (c?.menu?.buttons.length) return { kind: "menu", at: `${vm.where()} cell ${vm.state.cellN}` };
  return { kind: "stopped", why: `no menu at ${vm.where()}` };
}

function walkDvd(pack: DvdPack, opts: WalkOptions): WalkResult {
  const maxPages = opts.maxPages ?? 200;
  const lang = pack.menu_lang || "en";
  const result: WalkResult = { schema: "walk-1", disc: "dvd", first_play: [], pages: [], truncated: false, unsupported: [] };
  const fresh = (): DvdVm => {
    const vm = new DvdVm(pack, { rnd: () => 0 });
    vm.start();
    settleDvd(vm);
    // First play straight into a title (an intro): let it end until a menu shows.
    for (let i = 0; i < FIRST_PLAY_LIMIT && !vm.stopped && vm.state.domain === "VTS"; i++) {
      vm.cellEnded();
      settleDvd(vm);
    }
    return vm;
  };
  const replay = (path: number[]): DvdVm => {
    const vm = fresh();
    for (const n of path) {
      const b = vm.cell?.menu?.buttons.find((x) => x.n === n);
      if (!b) break;
      vm.activate(b);
      settleDvd(vm);
    }
    return vm;
  };
  result.first_play.push(dvdOutcome(fresh()));
  const seen = new Set<string>();
  const queue: number[][] = [[]];
  while (queue.length) {
    const path = queue.shift()!;
    const vm = replay(path);
    const here = dvdOutcome(vm);
    if (here.kind !== "menu" || seen.has(here.at)) continue;
    if (seen.size >= maxPages) {
      result.truncated = true;
      break;
    }
    seen.add(here.at);
    const menu = vm.cell!.menu!;
    const page: WalkPage = { at: here.at, menu: here.at, page: vm.state.cellN, language: lang, path, buttons: [] };
    for (const b of menu.buttons as ButtonJson[]) {
      const w = replay(path);
      const wb = w.cell?.menu?.buttons.find((x) => x.n === b.n);
      if (wb) {
        w.activate(wb);
        settleDvd(w);
      }
      const outcome = dvdOutcome(w);
      if (outcome.kind === "menu" && outcome.at !== here.at) queue.push([...path, b.n]);
      const [x0, y0, x1, y1] = b.rect;
      page.buttons.push({ id: b.n, x: x0, y: y0, w: x1 - x0, h: y1 - y0, image: menu.background?.image ?? null, outcome });
    }
    result.pages.push(page);
  }
  return result;
}

/** Walk a pack's menus: `hdmv-1` or `dvd-1`. */
export function walk(pack: HdmvPack | DvdPack, opts: WalkOptions = {}): WalkResult {
  if (pack.schema === "hdmv-1") return walkHdmv(pack as HdmvPack, opts);
  if (pack.schema === "dvd-1") return walkDvd(pack as DvdPack, opts);
  throw new Error(`unknown pack schema ${String(pack.schema)}`);
}
