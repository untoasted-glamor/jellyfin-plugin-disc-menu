// The menu player page: runs a DVD menu pack in the browser. Menus are drawn from the pack (background,
// the disc's own subpicture overlay, per-button highlight images); title cells are handed to a
// Playback (Jellyfin or the stub). Keys: arrows move, Enter/Space activate, M or Escape = Menu,
// T = Title menu. Mouse hover selects, click or tap activates.
import { ButtonJson, CellJson, DvdVm, MediaCell, MenuJson, Pack } from "./dvdvm.js";
import {
  fmt, Jellyfin, JellyfinPlayback, mediaKey, Playback, PlayRequest, requestKey, serverRoot, StubPlayback, subtitleLabel,
} from "./playback.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The pack folder, from ?pack=<relative folder>/. Only this server's own addresses are accepted. */
function packBase(): string | null {
  const p = new URLSearchParams(location.search).get("pack");
  if (!p) return null;
  const u = new URL(p.endsWith("/") ? p : p + "/", location.href);
  return u.origin === location.origin ? u.href : null;
}
const base = packBase() ?? "";

let pack: Pack;
let vm: DvdVm;
let playback: Playback = new StubPlayback();
let timers: number[] = [];
let drawnCell: CellJson | null = null;
let titleWatch: { media: string; cellEnd: number | null } | null = null;
let busy = false;

const stage = $<HTMLDivElement>("stage");
const menuLayer = $<HTMLDivElement>("menu");
const titleLayer = $<HTMLDivElement>("title");
const statusEl = $<HTMLDivElement>("status");
const traceEl = $<HTMLPreElement>("trace");
const regsEl = $<HTMLPreElement>("regs");

// ---------------------------------------------------------------------------- trace / status

const trace: string[] = [];
function log(s: string): void {
  trace.push(s);
  if (trace.length > 400) trace.splice(0, trace.length - 400);
  traceEl.textContent = trace.join("\n");
  traceEl.scrollTop = traceEl.scrollHeight;
}

function showRegs(): void {
  const g = Array.from(vm.gprm).map((v, i) => `g${i}=${v}`).join(" ");
  regsEl.textContent =
    `${vm.stopped ? "stopped" : vm.where()} cell ${vm.state.cellN}\n${g}\n` +
    `audio(SPRM1)=${vm.sprm[1]} subp(SPRM2)=0x${vm.sprm[2].toString(16)} button(SPRM8)=${vm.highlighted}`;
}

function status(s: string): void {
  statusEl.textContent = s;
}

// ---------------------------------------------------------------------------- the main loop

function clearTimers(): void {
  timers.forEach((t) => window.clearTimeout(t));
  timers = [];
}

function later(ms: number, fn: () => void): void {
  timers.push(window.setTimeout(fn, ms));
}

/** Advance the VM past the current cell and draw whatever comes next. */
function next(): void {
  if (busy) return;
  busy = true;
  try {
    vm.cellEnded();
  } finally {
    busy = false;
  }
  render();
}

function render(): void {
  clearTimers();
  showRegs();
  if (vm.stopped) {
    stopTitle();
    showMenuLayer(null);
    status("The disc's navigation stopped (Exit). Press Restart.");
    return;
  }
  const cell = vm.cell!;
  if (vm.state.domain === "VTS") {
    showMenuLayer(null);
    const m = vm.media;
    if (!m) {
      stopTitle();
      status(`Title ${vm.sprm[4]} chapter ${vm.sprm[7]}: not in the library (${cell.dur.toFixed(1)} s), skipped`);
      later(500, next);
      return;
    }
    playTitleCell(m);
    return;
  }
  stopTitle();
  drawMenu(cell);
}

function afterCell(cell: CellJson): void {
  const pgc = vm.state.pgc;
  const last = vm.state.cellN === pgc.cells.length;
  const still = cell.still || (last ? pgc.still : 0);
  if (still === 255) return; // wait for a button
  later(still * 1000, next);
}

// ---------------------------------------------------------------------------- menus

let bgAudio: HTMLAudioElement | null = null;

function showMenuLayer(menu: MenuJson | null): void {
  menuLayer.hidden = !menu;
  titleLayer.hidden = !!menu || vm.stopped || vm.state.domain !== "VTS";
  if (!menu) {
    menuLayer.replaceChildren();
    drawnCell = null;
    if (bgAudio) bgAudio.pause();
    bgAudio = null;
  }
}

function pct(v: number, of: number): string {
  return `${((v / of) * 100).toFixed(3)}%`;
}

function drawMenu(cell: CellJson): void {
  const menu = cell.menu ?? null;
  const where = vm.where();
  if (!menu) {
    // A cell with no buttons and no background (a short black cell): show black for its length.
    showMenuLayer(null);
    titleLayer.hidden = true;
    status(`${where}: blank cell (${cell.dur.toFixed(1)} s)`);
    later(Math.max(cell.dur, 0.05) * 1000, () => afterCell(cell));
    return;
  }
  const sameCell = drawnCell === cell;
  if (!sameCell) {
    showMenuLayer(null);
    menuLayer.hidden = false;
    stage.style.aspectRatio = menu.aspect === "4:3" ? "4 / 3" : "16 / 9";
    const bg = menu.background;
    if (bg?.video) {
      const v = document.createElement("video");
      v.src = base + bg.video;
      v.className = "layer";
      v.playsInline = true;
      v.autoplay = true;
      v.addEventListener("ended", () => afterCell(cell));
      menuLayer.append(v);
    } else if (bg?.image) {
      const i = document.createElement("img");
      i.src = base + bg.image;
      i.className = "layer";
      i.alt = "";
      menuLayer.append(i);
    }
    if (bg?.audio) {
      bgAudio = new Audio(base + bg.audio);
      bgAudio.addEventListener("ended", () => afterCell(cell));
      bgAudio.play().catch(() => status("Click the page once to allow menu audio."));
    }
    if (menu.overlay) {
      const o = document.createElement("img");
      o.src = base + menu.overlay;
      o.className = "layer";
      o.alt = "";
      menuLayer.append(o);
    }
    const [w, h] = menu.size;
    for (const b of menu.buttons) {
      const d = document.createElement("div");
      d.className = "btn";
      d.dataset.n = String(b.n);
      d.title = b.txt;
      Object.assign(d.style, {
        left: pct(b.rect[0], w), top: pct(b.rect[1], h),
        width: pct(b.rect[2] - b.rect[0] + 1, w), height: pct(b.rect[3] - b.rect[1] + 1, h),
      });
      for (const st of ["selected", "activated"] as const) {
        if (b[st]) {
          const i = document.createElement("img");
          i.src = base + b[st]!;
          i.className = st;
          i.alt = "";
          d.append(i);
        }
      }
      // pointermove, not mouseenter: a pointer resting where a new menu draws a button must not steal
      // the highlight from the keyboard or remote.
      d.addEventListener("pointermove", () => {
        if (vm.highlighted !== b.n) highlight(b.n);
      });
      d.addEventListener("click", (e) => {
        e.preventDefault();
        press(b);
      });
      menuLayer.append(d);
    }
    drawnCell = cell;
    let start = menu.forced_select || vm.highlighted;
    if (!menu.buttons.some((b) => b.n === start)) start = menu.buttons[0]?.n ?? 0;
    if (start) vm.select(start);
  } else {
    // The disc looped back to the same cell (e.g. LinkTopPG at the end of a motion menu): restart it.
    const v = menuLayer.querySelector("video");
    if (v) {
      v.currentTime = 0;
      v.play().catch(() => {});
    }
    if (bgAudio) {
      bgAudio.currentTime = 0;
      bgAudio.play().catch(() => {});
    }
  }
  paintHighlight();
  status(`${where}: menu, ${menu.buttons.length} buttons`);
  if (!menu.background?.video && !menu.background?.audio) later(Math.max(cell.dur, 0.05) * 1000, () => afterCell(cell));
  if (menu.forced_action) {
    const b = menu.buttons.find((x) => x.n === menu.forced_action);
    if (b) later(0, () => press(b));
  }
}

function currentButtons(): ButtonJson[] {
  return drawnCell?.menu?.buttons ?? [];
}

function paintHighlight(activated = false): void {
  const n = vm.highlighted;
  menuLayer.querySelectorAll<HTMLDivElement>(".btn").forEach((d) => {
    const on = Number(d.dataset.n) === n;
    d.classList.toggle("on", on && !activated);
    d.classList.toggle("act", on && activated);
  });
  showRegs();
}

function highlight(n: number): void {
  vm.select(n);
  paintHighlight();
  const b = currentButtons().find((x) => x.n === n);
  if (b?.auto) press(b);
}

function press(b: ButtonJson): void {
  vm.select(b.n);
  paintHighlight(true);
  clearTimers();
  later(150, () => {
    vm.activate(b);
    render();
  });
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === "m" || k === "M" || k === "Escape") {
    menuKey("root");
  } else if (k === "t" || k === "T") {
    menuKey("title");
  } else if (!menuLayer.hidden) {
    const b = currentButtons().find((x) => x.n === vm.highlighted);
    if (!b) return;
    const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[k] as
      | "up" | "down" | "left" | "right" | undefined;
    if (dir) {
      if (b.nav[dir]) highlight(b.nav[dir]);
    } else if (k === "Enter" || k === " ") {
      press(b);
    } else return;
  } else return;
  e.preventDefault();
}

function menuKey(which: "root" | "title"): void {
  stopTitle();
  if (!vm.menuCall(which)) status(`The disc has no ${which} menu here.`);
  render();
}

// ---------------------------------------------------------------------------- titles

function stopTitle(): void {
  if (playback.key) playback.stop();
  titleWatch = null;
}

/** "S01E03" for an episode, the file name for a movie. */
function mediaTitle(m: MediaCell): string {
  if (m.episode === undefined) return m.file;
  return `S${String(pack.disc.season ?? 1).padStart(2, "0")}E${String(m.episode).padStart(2, "0")}`;
}

/** Where the file plays to, as far as the pack knows: the end of the last cell mapped to it. */
function fileLength(m: MediaCell): number {
  const key = mediaKey(m);
  let end = 0;
  for (const [where, map] of Object.entries(pack.media)) {
    const [vtsN, pgcN] = where.split(":").map(Number);
    const cells = pack.vts[String(vtsN)]?.title_pgcs[pgcN - 1]?.cells ?? [];
    for (const [n, c] of Object.entries(map.cells)) {
      if (mediaKey(c) === key) end = Math.max(end, c.offset + (cells[Number(n) - 1]?.dur ?? 0));
    }
  }
  return end;
}

function request(m: MediaCell): PlayRequest {
  const v = pack.vts[String(vm.state.vtsN)];
  const a = v.audio[vm.sprm[1]];
  const sp = vm.sprm[2];
  const sub = sp & 0x40 ? v.subp[sp & 0x3f] : undefined;
  return {
    media: mediaKey(m),
    title: mediaTitle(m),
    offset: m.offset,
    length: fileLength(m),
    audioLang3: a ? a.lang3 : null,
    sidecar: sub?.sidecar ?? null,
    subLang3: sub?.lang3 ?? null,
    label: `title ${vm.sprm[4]}, chapter ${vm.sprm[7]}`,
  };
}

function cellEndFor(m: MediaCell): number | null {
  const nextCell = pack.media[`${vm.state.vtsN}:${vm.state.pgcN}`]?.cells[String(vm.state.cellN + 1)];
  return nextCell && mediaKey(nextCell) === mediaKey(m) ? nextCell.offset : null;
}

function playTitleCell(m: MediaCell): void {
  titleLayer.hidden = false;
  if (!titleLayer.contains(playback.el)) titleLayer.replaceChildren(playback.el);
  const r = request(m);
  status(`Playing ${r.title} from ${fmt(m.offset)} (${r.label}), ` +
    `audio ${r.audioLang3 ?? "default"}, subtitles ${subtitleLabel(r)}`);
  const cont = playback.key === requestKey(r);
  titleWatch = { media: r.media, cellEnd: cellEndFor(m) };
  if (cont && Math.abs(playback.time() - m.offset) < 3) return; // carry on, same stream
  if (cont) playback.seek(m.offset);
  else void playback.load(r);
}

function wirePlayback(p: Playback): void {
  p.ontime = (t) => {
    if (titleWatch && titleWatch.cellEnd !== null && t >= titleWatch.cellEnd - 0.1) next();
  };
  p.onended = () => {
    // The file ended: finish every remaining cell that plays from it, then go on.
    const media = titleWatch?.media;
    let guard = 0;
    const sameFile = () => vm.media !== null && mediaKey(vm.media) === media;
    while (!vm.stopped && vm.state.domain === "VTS" && sameFile() && guard++ < 100) vm.cellEnded();
    playback.key = null;
    render();
  };
  p.onerror = (msg) => {
    status(`Playback error: ${msg}`);
    log(`playback error: ${msg}`);
  };
}

// ---------------------------------------------------------------------------- Jellyfin settings

async function connect(): Promise<void> {
  const key = $<HTMLInputElement>("jf-key").value.trim();
  const out = $<HTMLSpanElement>("jf-state");
  try {
    localStorage.setItem("discmenu.apiKey", key);
  } catch {
    /* private window: keep it for this page only */
  }
  if (!key) {
    usePlayback(new StubPlayback());
    out.textContent = "Not connected: title cells show what would play.";
    return;
  }
  out.textContent = "Connecting...";
  try {
    if (pack.disc.season === undefined) throw new Error("playing a movie through Jellyfin isn't supported yet");
    const jf = new Jellyfin(serverRoot(), key);
    const { title, items } = await jf.resolveSeries(pack.disc.name, pack.disc.season);
    const wanted = new Map(Object.values(pack.media).flatMap((m) => Object.values(m.cells).map((c) => [mediaKey(c), c])));
    const missing = [...wanted].filter(([k]) => !items.has(k)).map(([, c]) => mediaTitle(c));
    usePlayback(new JellyfinPlayback(jf, items));
    out.textContent = `Connected: ${title}, ${wanted.size - missing.length} of ${wanted.size} files found` +
      (missing.length ? ` (missing ${missing.join(", ")})` : "");
  } catch (e) {
    usePlayback(new StubPlayback());
    out.textContent = `Couldn't connect: ${(e as Error).message}. Using the stub.`;
  }
}

function usePlayback(p: Playback): void {
  stopTitle();
  playback = p;
  wirePlayback(p);
  if (vm && !vm.stopped && vm.state.domain === "VTS") render();
}

// ---------------------------------------------------------------------------- start

function restart(): void {
  stopTitle();
  trace.length = 0;
  vm = new DvdVm(pack, { log });
  vm.start();
  render();
}

async function main(): Promise<void> {
  if (!base) {
    status("No menu pack given: open this page with ?pack=<pack folder>/ on this server.");
    $<HTMLButtonElement>("start").disabled = true;
    return;
  }
  const r = await fetch(base + "menu.json");
  if (!r.ok) {
    status(`Couldn't load the menu pack: ${r.status} ${r.statusText}`);
    $<HTMLButtonElement>("start").disabled = true;
    return;
  }
  pack = (await r.json()) as Pack;
  // Warm the cache with every menu image so a menu never paints half-loaded.
  const menus = [pack.vmg.menus, ...Object.values(pack.vts).map((v) => v.menus)].flatMap((m) => Object.values(m).flat());
  for (const cell of menus.flatMap((p) => p.cells)) {
    const m = cell.menu;
    if (!m) continue;
    for (const f of [m.background?.image, m.overlay, ...m.buttons.flatMap((b) => [b.selected, b.activated])]) {
      if (f) new Image().src = base + f;
    }
  }
  document.title = `Disc menu: ${pack.disc.name}`;
  $("disc-name").textContent = pack.disc.name;
  try {
    $<HTMLInputElement>("jf-key").value = localStorage.getItem("discmenu.apiKey") ?? "";
  } catch {
    /* no storage */
  }
  wirePlayback(playback);
  $("jf-connect").addEventListener("click", () => void connect());
  $("btn-menu").addEventListener("click", () => menuKey("root"));
  $("btn-title").addEventListener("click", () => menuKey("title"));
  $("btn-restart").addEventListener("click", restart);
  document.addEventListener("keydown", onKey);
  const go = $<HTMLButtonElement>("start");
  go.addEventListener("click", () => {
    go.parentElement!.hidden = true;
    restart();
  });
  if ($<HTMLInputElement>("jf-key").value) await connect();
}

void main();
