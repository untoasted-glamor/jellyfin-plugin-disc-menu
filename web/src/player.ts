// The menu player page: runs a DVD or Blu-ray menu pack in the browser. DVD menus are drawn from the pack (background,
// the disc's own subpicture overlay, per-button highlight images); a Blu-ray's (hdmv-1) are bdpage.ts's. Keys: arrows move, Enter/Space activate, M = Menu,
// T = Title menu (and Escape = Menu outside the overlay). Mouse hover selects, click or tap activates.
//
// The page opens a series' or movie's pack from the plugin with ?item=<id> (and &disc=<pack>, else the item's only
// pack or a choice). ?pack=<folder>/ opens a pack folder on the same server with no login, for testing the menus.
//
// With &embed=1 inside a frame, the page runs in the Disc menu button's overlay in the web client (see embed.ts): it
// shows only the menu, full screen, with a control bar that comes and goes, and uses the web client's login only.
// When the disc starts a title the library has, after the viewer pressed a menu button, the page hands it to the web
// client's own player (handoff.ts) and the overlay closes: one way, there is no return to the menu. A title the disc
// starts before any button press (logos, warnings) is skipped, so the disc gets to its menu.
//
// Opened by hand (not embedded), the page plays nothing from the library: a title cell shows what would play, with the
// stub's clock, and what the overlay would hand off. It signs in with the web client's saved login where the browser has
// one, else its own sign-in (Quick Connect, or a user name and password); see jellyfin.ts.
//
// Everything the page shows goes into the tab's log too, with a level, and the VM's trace beside it (debuglog.ts). The
// Stats panel (stats.ts; D, or the Stats button) shows it with the live state. With its "Wait before playing from menu"
// switch on, a title the disc starts waits on a notice instead of going to the web client's player.
import { AutoplayGate } from "./autoplay.js";
import { BdPage, menuFiles } from "./bdpage.js";
import { DebugLog, Level, tabStore } from "./debuglog.js";
import { discButton } from "./dom.js";
import { checkedMessage, CheckResult, embedInPlayer, isBackKey, isEmbedded, isInfoKey, PlayHandoff } from "./embed.js";
import { ButtonJson, CellJson, DvdVm, MediaCell, MenuJson, Pack } from "./dvdvm.js";
import type { HdmvPack } from "./hdmvvm.js";
import { describeHandoff, handoffDetail, handoffFor, handoffReasons, StreamRegs, titleAction, waitNotice } from "./handoff.js";
import { StatsPanel } from "./stats.js";
import {
  browserStore, DiscInfo, encodePath, fmt, forgetPageLogin, HttpError, Jellyfin, loginsFor, MediaItem, mediaItems,
  mediaKey, PlayRequest, requestKey, savedLogins, savePageLogin, serverRoot, StubPlayback, subtitleLabel,
} from "./playback.js";

declare const __PLAYER_VERSION__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
/** The series or movie whose pack plays, from ?item=. */
const itemId = params.get("item");
let discId = params.get("disc");
/** Inside the Disc menu button's overlay. */
const embedded = isEmbedded(window, params);
const overlay = embedded ? embedInPlayer(window) : null;

/** A test pack folder, from ?pack=<relative folder>/. Only this server's own addresses are accepted. */
function testPackBase(): string | null {
  const p = params.get("pack");
  if (!p) return null;
  const u = new URL(p.endsWith("/") ? p : p + "/", location.href);
  return u.origin === location.origin ? u.href : null;
}

/** Where the pack's files are, and the connection that signs requests for them (none for a test pack). */
let base = "";
let packJf: Jellyfin | null = null;

/** A pack file's URL for an img, video or audio element. */
function packUrl(file: string): string {
  const url = base + encodePath(file);
  return packJf ? packJf.withKey(url) : url;
}

let pack: Pack;
let vm: DvdVm;
/** A Blu-ray pack, and the page part that runs it (instead of pack and vm). */
let bdPack: HdmvPack | null = null;
let bd: BdPage | null = null;
const disc = () => (bdPack ?? pack).disc;
/** A pack is loaded, and the viewer has started the disc (so there is a VM to send keys to). */
let loaded = false;
let running = false;
const playback = new StubPlayback();
/** The library items the pack's files map to (the plugin's Media route), keyed like the pack's cells. */
let items = new Map<string, MediaItem>();
/** Set at the viewer's first menu button press: SPRM 1 and 2 as they were then (see handoff.ts). */
let baseline: StreamRegs | null = null;
/** A title went to the web client's player; the page does nothing more. */
let handedOff = false;
/** A hand-off held by "Wait before playing from menu", until Play or Back to menu. */
let held: PlayHandoff | null = null;
let serverVersion = "";
let timers: number[] = [];
let drawnCell: CellJson | null = null;
let titleWatch: { media: string; cellEnd: number | null } | null = null;
let busy = false;

const stage = $<HTMLDivElement>("stage");
const menuLayer = $<HTMLDivElement>("menu");
const titleLayer = $<HTMLDivElement>("title");
const statusEl = $<HTMLDivElement>("status");
const bar = $<HTMLDivElement>("bar");
const unblock = $<HTMLButtonElement>("unblock");
const waitEl = $<HTMLDivElement>("wait");

const autoplay = new AutoplayGate(() => {
  unblock.hidden = false;
  status("The browser held back the menu's sound. Press Start.", "warn");
});

// ---------------------------------------------------------------------------- the log, the status line and Stats

const store = browserStore();
const dlog = new DebugLog(tabStore(window));

/** The VM's trace: the commands it runs. */
function log(s: string): void {
  dlog.trace(s);
}

let lastStatus = "";
/** The status line (the page opened by hand shows it), and the log. A motion menu that loops doesn't repeat its line. */
function status(s: string, level: Level = "info"): void {
  statusEl.textContent = s;
  if (s !== lastStatus || level !== "info") dlog.add(level, s);
  lastStatus = s;
}

function mediaState(el: HTMLMediaElement | null): string {
  if (!el) return "none";
  if (!el.paused) return el.muted ? "playing (muted)" : "playing";
  return autoplay.blocked ? "held back by the browser" : "paused";
}

/** The live state at the top of the Stats panel and of a copied log. */
function liveState(): string[] {
  const lines = [
    `Disc: ${loaded ? disc().name : "no pack loaded"}; pack ${discId ?? params.get("pack") ?? "none"}; schema ${loaded ? (bdPack ?? pack).schema : "none"}`,
  ];
  if (bd) {
    lines.push(...bd.state(), `Menu: background video ${mediaState(menuLayer.querySelector("video"))}`);
  } else if (!vm) lines.push("VM: not started");
  else {
    const sp = vm.sprm[2];
    lines.push(
      `VM: ${vm.stopped ? "stopped" : `${vm.where()} cell ${vm.state.cellN}`}`,
      `Title ${vm.sprm[4]}, chapter ${vm.sprm[7]}; audio (SPRM 1) ${vm.sprm[1]}; subpicture (SPRM 2) 0x${sp.toString(16)} ` +
        `(stream ${sp & 0x3f}, ${sp & 0x40 ? "shown" : "hidden"}); button (SPRM 8) ${vm.highlighted}`,
      `GPRMs: ${Array.from(vm.gprm).map((v, i) => `g${i}=${v}`).join(" ")}`,
    );
    const menu = drawnCell?.menu;
    lines.push(
      menu
        ? `Menu: ${menu.buttons.length} buttons; background video ${mediaState(menuLayer.querySelector("video"))}, audio ${mediaState(bgAudio)}`
        : `Menu: none showing${vm.state.domain === "VTS" ? " (a title)" : ""}`,
    );
    if (baseline) lines.push(`At the first button press: audio (SPRM 1) ${baseline.audio}, subpicture (SPRM 2) 0x${baseline.subp.toString(16)}`);
  }
  lines.push(
    `Sign-in: ${$("jf-account").textContent ?? ""}`,
    `Library: ${$("jf-state").textContent ?? ""}`,
    `Versions: plugin ${__PLAYER_VERSION__}, server ${serverVersion || "unknown"}`,
    `Open ${dlog.run} of the Disc menu in this tab, ${embedded ? "in the overlay" : "on the page opened by hand"}; ` +
      `wait before playing from menu ${stats.wait ? "on" : "off"}`,
  );
  return lines;
}

const stats = new StatsPanel(document, stage, dlog, {
  embedded,
  state: liveState,
  prefs: store,
  toggles: [$<HTMLButtonElement>("bar-stats"), $<HTMLButtonElement>("btn-stats")],
  onWait: (on) => dlog.add("info", `Wait before playing from menu: ${on ? "on" : "off"}`),
});

function showRegs(): void {
  stats.refresh();
}

/** A menu file that doesn't load is an error in the log (the menu shows without it). */
function watchLoad(el: HTMLImageElement | HTMLMediaElement, file: string): void {
  el.addEventListener("error", () => dlog.add("error", `Couldn't load the menu file ${file}`), { once: true });
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
  if (handedOff || held) return;
  showRegs();
  if (vm.stopped) {
    stopTitle();
    showMenuLayer(null);
    status("The disc's navigation stopped (Exit). Press Restart.");
    return;
  }
  const cell = vm.cell!;
  if (vm.state.domain === "VTS") {
    const m = vm.media;
    const item = m ? items.get(mediaKey(m)) : undefined;
    const action = titleAction({ embedded, mapped: !!m, inLibrary: !!item, pressed: !!baseline });
    // A held hand-off keeps the last menu showing, dimmed, behind its notice.
    if (action === "hand-off" && stats.wait) return handOff(m!, item!);
    showMenuLayer(null);
    if (action === "missing") {
      stopTitle();
      status(`Title ${vm.sprm[4]} chapter ${vm.sprm[7]}: not in the library (${cell.dur.toFixed(1)} s), skipped`, "warn");
      later(500, next);
    } else if (action === "intro") skipTitle();
    else if (action === "hand-off") handOff(m!, item!);
    else playTitleCell(m!, item);
    return;
  }
  stopTitle();
  drawMenu(cell);
}

/**
 * A title the disc starts before the viewer pressed any menu button (logos, warnings at first play): skip all of it at
 * once, as if it had played to its end, so the disc gets to its menu.
 */
function skipTitle(): void {
  const { vtsN, pgcN } = vm.state;
  const where = `title ${vm.sprm[4]}`;
  let guard = 0;
  let length = 0;
  while (!vm.stopped && vm.state.domain === "VTS" && vm.state.vtsN === vtsN && vm.state.pgcN === pgcN && guard++ < 1000) {
    length += vm.cell?.dur ?? 0;
    vm.cellEnded();
  }
  status(`The disc started ${where} before any menu button was pressed: skipped (${length.toFixed(1)} s), to get to the menu`, "warn");
  log(`skipped ${where} (no menu button pressed yet)`);
  later(500, render);
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
  titleLayer.hidden = !!menu || vm.stopped || vm.state.domain !== "VTS" || embedded;
  if (!menu) {
    menuLayer.replaceChildren();
    drawnCell = null;
    if (bgAudio) bgAudio.pause();
    bgAudio = null;
    autoplay.clear();
    unblock.hidden = true;
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
    const four = menu.aspect === "4:3";
    stage.style.aspectRatio = four ? "4 / 3" : "16 / 9";
    stage.style.setProperty("--ar", four ? String(4 / 3) : String(16 / 9));
    const bg = menu.background;
    if (bg?.video) {
      const v = document.createElement("video");
      v.src = packUrl(bg.video);
      watchLoad(v, bg.video);
      v.className = "layer";
      v.playsInline = true;
      v.addEventListener("ended", () => afterCell(cell));
      menuLayer.append(v);
      autoplay.play(v, true);
    } else if (bg?.image) {
      const i = document.createElement("img");
      i.src = packUrl(bg.image);
      watchLoad(i, bg.image);
      i.className = "layer";
      i.alt = "";
      menuLayer.append(i);
    }
    if (bg?.audio) {
      bgAudio = new Audio(packUrl(bg.audio));
      watchLoad(bgAudio, bg.audio);
      bgAudio.addEventListener("ended", () => afterCell(cell));
      autoplay.play(bgAudio, false);
    }
    if (menu.overlay) {
      const o = document.createElement("img");
      o.src = packUrl(menu.overlay);
      watchLoad(o, menu.overlay);
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
          i.src = packUrl(b[st]!);
          watchLoad(i, b[st]!);
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
        viewerPress(b);
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
      autoplay.play(v, true);
    }
    if (bgAudio) {
      bgAudio.currentTime = 0;
      autoplay.play(bgAudio, false);
    }
  }
  paintHighlight();
  if (!autoplay.blocked) status(`${where}: menu, ${menu.buttons.length} buttons`);
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

/** The viewer pressed a menu button (a key, a click or a tap). The disc's own forced or automatic presses don't count. */
function viewerPress(b: ButtonJson): void {
  baseline ??= { audio: vm.sprm[1], subp: vm.sprm[2] };
  dlog.add("info", `Button ${b.n} pressed${b.txt ? ` (${b.txt})` : ""} in ${vm.where()}`);
  press(b);
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

// ---------------------------------------------------------------------------- keys and the overlay's control bar

const BAR_MS = 3000;
let barTimer = 0;

/** Shows the bar (in the overlay only) for a few seconds, or until the focus leaves it; `focus` puts the focus on it. */
function showBar(focus = false): void {
  if (!embedded || handedOff) return;
  bar.hidden = false;
  if (focus) bar.querySelector<HTMLButtonElement>("button:not([hidden])")?.focus();
  window.clearTimeout(barTimer);
  barTimer = window.setTimeout(() => {
    if (!bar.contains(document.activeElement)) hideBar();
    else showBar();
  }, BAR_MS);
}

function hideBar(): void {
  window.clearTimeout(barTimer);
  const had = bar.contains(document.activeElement);
  bar.hidden = true;
  if (had) (document.activeElement as HTMLElement).blur();
}

/** Keys while the focus is on the bar: Left and Right move along it, Back or Info hide it, Enter presses (natively). */
function barKey(e: KeyboardEvent): void {
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button:not([hidden])")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const to = buttons[(at + (e.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length];
    to?.focus();
    showBar();
  } else if (isBackKey(e) || isInfoKey(e)) {
    hideBar();
  } else if (e.key === "Enter" || e.key === " ") {
    showBar();
    return; // the button's own click
  } else return;
  e.preventDefault();
}

/** Keys while the focus is on the wait notice: Left and Right move between its buttons, Enter presses (natively). */
function waitKey(e: KeyboardEvent): boolean {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return e.key === "Enter" || e.key === " ";
  const buttons = [...waitEl.querySelectorAll<HTMLButtonElement>("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[(at + 1) % buttons.length]?.focus();
  e.preventDefault();
  return true;
}

function onKey(e: KeyboardEvent): void {
  // Typing in the sign-in form isn't a remote's key, and before Start there is nothing to send keys to.
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, [contenteditable]")) return;
  if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    stats.toggle();
    return;
  }
  if (t && stats.el.contains(t)) {
    if (stats.key(e, isBackKey(e)) || e.key === "Enter" || e.key === " ") return;
  }
  if (t && waitEl.contains(t) && waitKey(e)) return;
  if (embedded) {
    if (bar.contains(t)) return barKey(e);
    if (isInfoKey(e)) {
      e.preventDefault();
      if (bar.hidden) showBar(true);
      else hideBar();
      return;
    }
    if (isBackKey(e)) {
      e.preventDefault();
      overlay!.requestClose();
      return;
    }
  }
  if (!running) return;
  const k = e.key;
  if (bd) {
    if (k === "m" || k === "M" || (k === "Escape" && !embedded)) menuKey("root");
    else if (k === "t" || k === "T") menuKey("title");
    else if (menuLayer.hidden || held || !bd.key(k)) return;
    e.preventDefault();
    return;
  }
  // In the overlay the page is full screen, where the browser keeps Escape for leaving full screen.
  if (k === "m" || k === "M" || (k === "Escape" && !embedded)) {
    menuKey("root");
  } else if (k === "t" || k === "T") {
    menuKey("title");
  } else if (!menuLayer.hidden && !held) {
    const b = currentButtons().find((x) => x.n === vm.highlighted);
    if (!b) return;
    const dir = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[k] as
      | "up" | "down" | "left" | "right" | undefined;
    if (dir) {
      if (b.nav[dir]) highlight(b.nav[dir]);
    } else if (k === "Enter" || k === " ") {
      viewerPress(b);
    } else return;
  } else return;
  e.preventDefault();
}

function menuKey(which: "root" | "title"): void {
  if (!running) return;
  hideWait();
  stopTitle();
  if (bd) {
    // A Blu-ray's title menu is its pop-up menu, which the player leaves out.
    if (which === "title") status("The disc's pop-up menu isn't supported; Menu goes to its top menu.", "warn");
    else bd.topMenu();
    return;
  }
  if (!vm.menuCall(which)) status(`The disc has no ${which} menu here.`, "warn");
  render();
}

// ---------------------------------------------------------------------------- titles

function stopTitle(): void {
  if (playback.key) playback.stop();
  titleWatch = null;
}

/** Stops everything: the VM's timers, the stub's clock, and a menu's background video or audio. */
function stopAll(): void {
  clearTimers();
  running = false;
  bgAudio?.pause();
  menuLayer.querySelector("video")?.pause();
  stopTitle();
}

/** "S01E03" for an episode ("S00E01" for a special), the file name for an extra or a movie. */
function mediaTitle(m: Partial<MediaCell> & Pick<MediaCell, "file">): string {
  if (m.extra != null) return m.extra.split("/").pop() || m.file;
  if (m.episode == null) return m.file;
  return `S${String(m.season ?? disc().season ?? 1).padStart(2, "0")}E${String(m.episode).padStart(2, "0")}`;
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

/** What the overlay hands to the web client's player for this cell. */
function handoff(m: MediaCell, item: MediaItem): PlayHandoff {
  return handoffFor(item, request(m), { audio: vm.sprm[1], subp: vm.sprm[2] }, baseline ?? { audio: vm.sprm[1], subp: vm.sprm[2] });
}

/**
 * In the overlay: the title goes to the web client's own player, and the menu is done. The log gets what goes with it
 * and why; with "Wait before playing from menu" on, the hand-off waits on a notice instead (waitHandOff).
 */
function handOff(m: MediaCell, item: MediaItem): void {
  const h = handoff(m, item);
  const r = request(m);
  const now = { audio: vm.sprm[1], subp: vm.sprm[2] };
  const detail = handoffDetail(h, handoffReasons(item, r, now, baseline ?? now));
  if (stats.wait) {
    status(`Waiting before playing ${r.label} from the menu: ${describeHandoff(h)}`);
    dlog.add("info", `It would send: ${detail}`);
    waitHandOff(h);
    return;
  }
  status(`Handing ${r.label} to Jellyfin's player: ${describeHandoff(h)}`);
  dlog.add("info", `It sends: ${detail}`);
  sendHandOff(h);
}

function sendHandOff(h: PlayHandoff): void {
  log(`hand-off: ${describeHandoff(h)}`);
  // Written now, so the web client adds what it made of the hand-off to this log.
  dlog.flush();
  handedOff = true;
  stopAll();
  hideBar();
  overlay!.handOff(h);
}

/** Holds the hand-off on a notice: the overlay checks everything but the Play command (CHECK), the menu's media stops. */
function waitHandOff(h: PlayHandoff): void {
  held = h;
  clearTimers();
  bgAudio?.pause();
  menuLayer.querySelector("video")?.pause();
  menuLayer.classList.add("held");
  stopTitle();
  const text = $<HTMLParagraphElement>("wait-text");
  text.textContent = waitNotice(h).join("\n");
  waitEl.hidden = false;
  $<HTMLButtonElement>("wait-play").focus();
  overlay!.check(h);
}

/** The overlay's answer to CHECK: in the log, and on the notice when no session would get the Play command. */
function checked(r: CheckResult): void {
  if (!held) return;
  dlog.add(r.session ? "info" : "warn", `Checked without playing: ${r.detail}`);
  if (!r.session) {
    const text = $<HTMLParagraphElement>("wait-text");
    text.textContent = [...waitNotice(held), "Session: none found (Play would open the details page)"].join("\n");
  }
}

function hideWait(): void {
  held = null;
  waitEl.hidden = true;
  menuLayer.classList.remove("held");
  if (waitEl.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
}

function cellEndFor(m: MediaCell): number | null {
  const nextCell = pack.media[`${vm.state.vtsN}:${vm.state.pgcN}`]?.cells[String(vm.state.cellN + 1)];
  return nextCell && mediaKey(nextCell) === mediaKey(m) ? nextCell.offset : null;
}

/** On the page opened by hand: the stub shows what would play, and what the overlay would hand off. */
function playTitleCell(m: MediaCell, item: MediaItem | undefined): void {
  titleLayer.hidden = false;
  if (!titleLayer.contains(playback.el)) titleLayer.replaceChildren(playback.el);
  const r = request(m);
  status(`Playing ${r.title} from ${fmt(m.offset)} (${r.label}), ` +
    `audio ${r.audioLang3 ?? "default"}, subtitles ${subtitleLabel(r)}` +
    (item ? `. The Disc menu button would hand off ${describeHandoff(handoff(m, item))}` : ""));
  const cont = playback.key === requestKey(r);
  titleWatch = { media: r.media, cellEnd: cellEndFor(m) };
  if (cont && Math.abs(playback.time() - m.offset) < 3) return; // carry on, same stream
  if (cont) playback.seek(m.offset);
  else playback.load(r);
}

function wirePlayback(p: StubPlayback): void {
  p.ontime = (t) => {
    if (titleWatch && titleWatch.cellEnd !== null && t >= titleWatch.cellEnd - 0.1) next();
  };
  p.onended = () => {
    if (bd) {
      playback.key = null;
      bd.showEnded();
      return;
    }
    // The file ended: finish every remaining cell that plays from it, then go on.
    const media = titleWatch?.media;
    let guard = 0;
    const sameFile = () => vm.media !== null && mediaKey(vm.media) === media;
    while (!vm.stopped && vm.state.domain === "VTS" && sameFile() && guard++ < 100) vm.cellEnded();
    playback.key = null;
    render();
  };
}

/** What bdpage.ts uses of the page. */
function bdHost() {
  return {
    doc: document,
    stage,
    menuLayer,
    embedded,
    packUrl,
    watchLoad,
    playVideo: (v: HTMLVideoElement) => autoplay.play(v, true),
    status,
    event: (level: Level, s: string) => dlog.add(level, s),
    trace: log,
    items: () => items,
    waitFirst: () => stats.wait,
    title: mediaTitle,
    send: sendHandOff,
    hold: waitHandOff,
    show: (r: PlayRequest) => {
      titleLayer.hidden = embedded;
      if (!titleLayer.contains(playback.el)) titleLayer.replaceChildren(playback.el);
      if (playback.key === requestKey(r)) playback.seek(r.offset);
      else playback.load(r);
    },
    stopShow: () => {
      stopTitle();
      titleLayer.hidden = true;
    },
    refresh: showRegs,
  };
}

// ---------------------------------------------------------------------------- Jellyfin

const jfState = (s: string) => ($<HTMLSpanElement>("jf-state").textContent = s);

/** The server with no login (signing in), its id, and the signed-in connection once there is one. */
let server: Jellyfin | null = null;
let serverId = "";
let jf: Jellyfin | null = null;
/** Set when the viewer asked for another account or the web client's token was refused: don't reuse it again. */
let skipWebLogin = false;

/** Signs in with a saved login (this page's own, then the web client's; the web client's only in the overlay). */
async function savedSignIn(): Promise<boolean> {
  for (const login of loginsFor(embedded, savedLogins(store, serverId))) {
    if (login.source === "web" && skipWebLogin) continue;
    const conn = server!.as(login, store);
    try {
      signedIn(conn, await conn.userName());
      return true;
    } catch (e) {
      if (!(e instanceof HttpError && (e.status === 401 || e.status === 403))) throw e;
      if (login.source === "page") forgetPageLogin(store, serverId);
      else skipWebLogin = true;
    }
  }
  return false;
}

function signedIn(conn: Jellyfin, name: string): void {
  jf = conn;
  stopQuickConnect();
  $("signin").hidden = true;
  const web = conn.login?.source === "web";
  $("jf-account").textContent = `Signed in as ${name}${web ? " (the web client's login)" : ""}.`;
  const sw = $<HTMLButtonElement>("jf-switch");
  sw.textContent = web ? "Use another account" : "Sign out";
  sw.hidden = false;
}

/** In the overlay with no usable web client login: the page has no sign-in of its own there. */
function noOverlayLogin(): void {
  jf = null;
  const why = "Jellyfin didn't take the web client's login. Sign in to the web client again, then open the Disc menu.";
  status(why, "error");
  $("splash-note").textContent = why;
  jfState("Not connected.");
}

/** Shows the sign-in: a Quick Connect code where the server has it on, and the user name and password form. */
async function showSignIn(why: string): Promise<void> {
  if (embedded) return noOverlayLogin();
  jf = null;
  $("jf-account").textContent = "Not signed in.";
  $("jf-switch").hidden = true;
  $("signin-why").textContent = why;
  $("signin-error").textContent = "";
  $("signin").hidden = false;
  status(why);
  jfState("Not connected.");
  const qc = await server!.quickConnectEnabled();
  $("qc").hidden = !qc;
  if (qc) void startQuickConnect();
  else $<HTMLInputElement>("pw-user").focus();
}

let qcTimer = 0;
let qcSecret: string | null = null;

function stopQuickConnect(): void {
  window.clearTimeout(qcTimer);
  qcSecret = null;
}

/** Asks for a Quick Connect code, then checks every few seconds whether a signed-in device approved it. */
async function startQuickConnect(): Promise<void> {
  stopQuickConnect();
  $<HTMLButtonElement>("qc-new").hidden = true;
  $("qc-code").textContent = "...";
  let req;
  try {
    req = await server!.quickConnectStart();
  } catch (e) {
    $("qc-code").textContent = "";
    $("qc-note").textContent = `Couldn't start Quick Connect: ${(e as Error).message}`;
    $<HTMLButtonElement>("qc-new").hidden = false;
    return;
  }
  const secret = (qcSecret = req.Secret);
  $("qc-code").textContent = req.Code;
  $("qc-note").textContent = "Waiting for the code to be approved...";
  const poll = async () => {
    if (qcSecret !== secret) return;
    try {
      const st = await server!.quickConnectState(secret);
      if (qcSecret !== secret) return;
      if (st.Authenticated) {
        const r = await server!.quickConnectFinish(secret);
        await signInAs(r.token, r.userId, r.name);
        return;
      }
    } catch (e) {
      if (qcSecret !== secret) return;
      if (e instanceof HttpError && (e.status === 404 || e.status === 401)) {
        qcSecret = null;
        $("qc-code").textContent = "";
        $("qc-note").textContent =
          e.status === 404 ? "The code has expired." : "Quick Connect was turned off on the server.";
        $<HTMLButtonElement>("qc-new").hidden = false;
        return;
      }
      // A network blip: keep waiting.
    }
    qcTimer = window.setTimeout(() => void poll(), 3000);
  };
  qcTimer = window.setTimeout(() => void poll(), 3000);
}

async function passwordSignIn(e: Event): Promise<void> {
  e.preventDefault();
  const user = $<HTMLInputElement>("pw-user").value.trim();
  const pass = $<HTMLInputElement>("pw-pass");
  const err = $("signin-error");
  err.textContent = "";
  if (!user) {
    err.textContent = "Enter your user name.";
    return;
  }
  try {
    const r = await server!.signIn(user, pass.value);
    pass.value = "";
    await signInAs(r.token, r.userId, r.name);
  } catch (ex) {
    err.textContent =
      ex instanceof HttpError && ex.status === 401 ? "Wrong user name or password." : `Couldn't sign in: ${(ex as Error).message}`;
  }
}

/** Keeps a login the page just made, then opens the item with it (from scratch if another user had it open). */
async function signInAs(token: string, userId: string, name: string): Promise<void> {
  const conn = server!.as(savePageLogin(store, serverId, token, userId), store);
  signedIn(conn, name);
  closePack();
  await openItem();
}

/** "Sign out" ends this page's own login; "Use another account" leaves the web client's alone and shows the sign-in. */
async function switchAccount(): Promise<void> {
  const conn = jf;
  if (!conn) return;
  stopTitle();
  if (conn.login?.source === "page") {
    await conn.signOut();
    forgetPageLogin(store, serverId);
  }
  skipWebLogin = true;
  await showSignIn(conn.login?.source === "page" ? "Signed out." : "Sign in with another account.");
}

/** A refused token mid-session (revoked, or signed out elsewhere): forget it and ask again. */
async function loginRefused(): Promise<void> {
  if (jf?.login?.source === "page") forgetPageLogin(store, serverId);
  else skipWebLogin = true;
  await showSignIn("Jellyfin no longer takes this login. Sign in again.");
}

/** Opens ?item='s pack (the one in &disc=, its only one, or the viewer's choice), then finds its files in the library. */
async function openItem(): Promise<void> {
  const conn = jf;
  if (!conn) return;
  try {
    if (!discId) {
      const discs = await conn.discs(itemId!);
      if (discs.length === 0) {
        status("This series or movie has no disc menus.", "warn");
        $("splash-note").textContent = "This series or movie has no disc menus.";
        jfState("Connected; no disc menus here.");
        return;
      }
      if (discs.length > 1) {
        chooseDisc(discs);
        return;
      }
      discId = discs[0].Id;
    }
    if (!loaded) await loadPack(`${conn.base}${conn.discsPath(itemId!)}/${encodeURIComponent(discId)}/Files/`, conn);
    await findMedia(conn);
    // In the overlay the menu starts at once: the viewer already chose it with the Disc menu button.
    if (embedded && !running) startDisc();
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof HttpError && e.status === 401) return loginRefused();
    if (e instanceof HttpError && (e.status === 404 || e.status === 403))
      status("This disc's menus aren't on this server, or this account can't see them.", "error");
    else status(`Couldn't open the disc: ${msg}`, "error");
    $("splash-note").textContent = statusEl.textContent;
    jfState(`Not connected: ${msg}`);
  }
}

/** Forgets the open pack, so another account opens it from scratch. */
function closePack(): void {
  stopTitle();
  clearTimers();
  running = false;
  items = new Map();
  if (!loaded) return;
  loaded = false;
  menuLayer.hidden = true;
  titleLayer.hidden = true;
  $<HTMLButtonElement>("start").parentElement!.hidden = false;
  $<HTMLButtonElement>("start").disabled = true;
}

function chooseDisc(discs: DiscInfo[]): void {
  status("This has more than one disc. Pick one.");
  $("splash-note").textContent = "This has more than one disc. Pick one.";
  const list = $<HTMLDivElement>("discs");
  list.replaceChildren(
    ...discs.map((d) =>
      discButton(document, d, () => {
        discId = d.Id;
        list.replaceChildren();
        const q = new URLSearchParams(location.search);
        q.set("disc", d.Id);
        history.replaceState(null, "", `?${q}`);
        void openItem();
      }),
    ),
  );
  if (embedded) list.querySelector("button")?.focus();
}

/** Asks the plugin which library item plays each of the pack's files. */
async function findMedia(jf: Jellyfin): Promise<void> {
  jfState("Connecting...");
  const media = await jf.media(itemId!, discId!);
  const missing = media.Titles.filter((t) => !t.ItemId).map((t) => mediaTitle({ file: t.File, episode: t.Episode, season: t.Season, extra: t.Extra }));
  items = mediaItems(media);
  const n = media.Titles.length;
  jfState(`Connected: ${media.Name}, ${n - missing.length} of ${n} files found` +
    (missing.length ? ` (missing ${missing.join(", ")})` : ""));
  dlog.add(missing.length ? "warn" : "info", `Library: ${n - missing.length} of ${n} of the pack's files found` +
    (missing.length ? `; missing ${missing.join(", ")}` : ""));
  if (running && !bd && !vm.stopped && vm.state.domain === "VTS") render();
}

// ---------------------------------------------------------------------------- start

function restart(): void {
  if (!loaded) return;
  stopTitle();
  hideWait();
  baseline = null;
  dlog.started();
  dlog.add("info", `Start disc: ${disc().name}`);
  running = true;
  if (bd) {
    titleLayer.hidden = true;
    bd.start();
    return;
  }
  vm = new DvdVm(pack, { log });
  vm.start();
  render();
}

function startDisc(): void {
  $<HTMLButtonElement>("start").parentElement!.hidden = true;
  restart();
}

/** Loads menu.json from a pack folder (signed with conn's token when given) and warms the menu images. */
async function loadPack(packBase: string, conn: Jellyfin | null): Promise<void> {
  base = packBase;
  packJf = conn;
  let json: Pack | HdmvPack;
  if (conn) {
    json = await conn.get<Pack | HdmvPack>(base.slice(conn.base.length) + "menu.json");
  } else {
    const r = await fetch(base + "menu.json");
    if (!r.ok) throw new HttpError(r.status, `${r.status} ${r.statusText}`);
    json = (await r.json()) as Pack | HdmvPack;
  }
  bd = null;
  bdPack = null;
  if (json.schema === "hdmv-1") {
    const p = json as HdmvPack;
    bdPack = p;
    bd = new BdPage(p, bdHost());
    // Warm the cache with every menu image so a menu never paints half-loaded.
    for (const f of menuFiles(p)) new Image().src = packUrl(f);
    return packLoaded();
  }
  pack = json as Pack;
  // Warm the cache with every menu image so a menu never paints half-loaded.
  const menus = [pack.vmg.menus, ...Object.values(pack.vts).map((v) => v.menus)].flatMap((m) => Object.values(m).flat());
  for (const cell of menus.flatMap((p) => p.cells)) {
    const m = cell.menu;
    if (!m) continue;
    for (const f of [m.background?.image, m.overlay, ...m.buttons.flatMap((b) => [b.selected, b.activated])]) {
      if (f) new Image().src = packUrl(f);
    }
  }
  packLoaded();
}

function packLoaded(): void {
  document.title = `Disc menu: ${disc().name}`;
  $("disc-name").textContent = disc().name;
  loaded = true;
  $<HTMLButtonElement>("start").disabled = false;
  status("Ready. Press Start disc.");
}

async function main(): Promise<void> {
  const go = $<HTMLButtonElement>("start");
  go.disabled = true;
  wirePlayback(playback);
  stats.restore();
  try {
    store.removeItem("discmenu.apiKey"); // the API key earlier versions kept
  } catch {
    /* nothing kept */
  }
  $("jf-switch").addEventListener("click", () => void switchAccount());
  $("pw-form").addEventListener("submit", (e) => void passwordSignIn(e));
  $("qc-new").addEventListener("click", () => void startQuickConnect());
  $("btn-menu").addEventListener("click", () => menuKey("root"));
  $("btn-title").addEventListener("click", () => menuKey("title"));
  $("btn-restart").addEventListener("click", restart);
  document.addEventListener("keydown", onKey);
  unblock.addEventListener("click", () => {
    unblock.hidden = true;
    autoplay.resume();
    if (running && !bd && drawnCell?.menu) status(`${vm.where()}: menu, ${drawnCell.menu.buttons.length} buttons`);
  });
  // The menus keep running for a page the browser restores from its back-forward cache; the stub's clock stops.
  window.addEventListener("pagehide", () => {
    stopTitle();
    dlog.flush();
  });
  window.addEventListener("error", (e) => dlog.add("error", `Script error: ${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: unknown } | null;
    dlog.add("error", `Unhandled rejection: ${typeof r?.message === "string" ? r.message : String(e.reason)}`);
  });
  $("btn-stats").addEventListener("click", () => stats.toggle(true));
  $("wait-back").addEventListener("click", () => {
    dlog.add("info", "Back to menu from the wait notice");
    menuKey("root");
  });
  $("wait-play").addEventListener("click", () => {
    const h = held;
    if (!h) return;
    hideWait();
    dlog.add("info", "Play pressed on the wait notice");
    sendHandOff(h);
  });
  if (embedded) {
    document.documentElement.classList.add("embedded");
    // Over the web client, whose default theme is dark.
    document.documentElement.dataset.theme = "dark";
    $("bar-close").addEventListener("click", () => overlay!.requestClose());
    $("bar-menu").addEventListener("click", () => menuKey("root"));
    $("bar-title").addEventListener("click", () => menuKey("title"));
    $<HTMLButtonElement>("bar-stats").hidden = false;
    $("bar-stats").addEventListener("click", () => stats.toggle(true));
    bar.addEventListener("focusin", () => showBar());
    window.addEventListener("message", (e) => {
      const r = checkedMessage(e, window.parent, location.origin);
      if (r) checked(r);
    });
    // A pointer that moves shows the bar; a resting one doesn't. A tap that misses every menu button shows it too.
    document.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") showBar();
    });
    stage.addEventListener("click", (e) => {
      if (!(e.target as Element).closest(".btn, .igb, button, .stats, .wait")) showBar();
    });
  }
  go.addEventListener("click", startDisc);

  if (itemId) {
    server = new Jellyfin(serverRoot(), null, store);
    try {
      const info = await server.publicInfo();
      serverId = info.Id;
      serverVersion = info.Version ?? "";
      if (info.ServerName) $("server-name").textContent = info.ServerName;
      if (await savedSignIn()) await openItem();
      else await showSignIn("Sign in to Jellyfin to open this disc's menus.");
    } catch (e) {
      status(`Couldn't reach Jellyfin: ${(e as Error).message}`, "error");
      $("splash-note").textContent = statusEl.textContent;
      jfState("Not connected.");
    }
    return;
  }
  $("jf-account").textContent = "No sign-in for a test pack; title cells show what would play.";
  const testPack = testPackBase();
  if (!testPack) {
    status("No menu pack given: open this page from a series or movie (?item=<id>), or with ?pack=<pack folder>/.", "error");
    return;
  }
  try {
    await loadPack(testPack, null);
  } catch (e) {
    status(`Couldn't load the menu pack: ${(e as Error).message}`, "error");
  }
}

void main();
