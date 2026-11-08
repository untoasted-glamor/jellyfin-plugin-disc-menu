// Drives the DVD VM the way the player page does, with no browser and no playback.
import { readFileSync } from "node:fs";
import { DvdVm, type Pack } from "../src/dvdvm.js";

export function loadPack(dir: string): Pack {
  return JSON.parse(readFileSync(new URL(`../fixtures/${dir}/menu.json`, import.meta.url), "utf8")) as Pack;
}

export function startVm(pack: Pack, lines: string[] = []): DvdVm {
  const vm = new DvdVm(pack, { log: (s) => lines.push(s), rnd: () => 0.5 });
  vm.start();
  return vm;
}

export type Stop = "menu" | "title" | "still" | "stopped" | "loop";

/**
 * Advance through every cell that needs no viewer: stop at a menu with buttons, a title cell the library has,
 * a still that waits for the viewer, or a stop. Title cells the library lacks are skipped, as the player does.
 */
export function settle(vm: DvdVm, skipped: string[] = []): Stop {
  for (let i = 0; i < 2000; i++) {
    if (vm.stopped) return "stopped";
    const c = vm.cell!;
    if (vm.state.domain === "VTS") {
      if (vm.media) return "title";
      skipped.push(`${vm.where()} cell ${vm.state.cellN}`);
      vm.cellEnded();
      continue;
    }
    if (c.menu && c.menu.buttons.length) return "menu";
    if (c.still === 255) return "still";
    vm.cellEnded();
  }
  return "loop";
}

/** One line for what the VM shows now: a menu, a title cell and what it plays, or a stop. */
export function describe(vm: DvdVm): string {
  if (vm.stopped) return "stopped";
  if (vm.state.domain === "VTS") {
    const m = vm.media;
    const v = vm.pack.vts[String(vm.state.vtsN)];
    const a = v.audio[vm.sprm[1]];
    const sp = vm.sprm[2];
    const sub = sp & 0x40 ? v.subp[sp & 0x3f] : null;
    const what = m ? `${m.episode !== undefined ? `E${m.episode}` : m.file} @ ${m.offset}s` : "not in the library";
    return (
      `title ${vm.sprm[4]} chapter ${vm.sprm[7]}: ${what}, audio ${a ? a.lang3 : "default"}` +
      `, subs ${sub ? (sub.sidecar ?? sub.lang3) : "off"}`
    );
  }
  const n = vm.cell?.menu?.buttons.length ?? 0;
  return `menu ${vm.where()} (${n} buttons, highlighted ${vm.highlighted})`;
}

/** Press a button of the current menu by its number, then settle. */
export function press(vm: DvdVm, n: number): Stop {
  const b = vm.cell?.menu?.buttons.find((x) => x.n === n);
  if (!b) throw new Error(`no button ${n} on ${describe(vm)}`);
  vm.activate(b);
  return settle(vm);
}

/** Move the highlight like the arrow keys do, from the current menu's navigation table. */
export function move(vm: DvdVm, dir: "up" | "down" | "left" | "right"): number {
  const b = vm.cell?.menu?.buttons.find((x) => x.n === vm.highlighted);
  if (!b) throw new Error(`no highlighted button on ${describe(vm)}`);
  if (b.nav[dir]) vm.select(b.nav[dir]);
  return vm.highlighted;
}

/** Let the current file play to its end: end cells until the title moves to another file or leaves VTS. */
export function playFileOut(vm: DvdVm): Stop {
  const m = vm.media;
  const key = m && (m.episode !== undefined ? `E${m.episode}` : m.file);
  const same = () => vm.media && (vm.media.episode !== undefined ? `E${vm.media.episode}` : vm.media.file) === key;
  while (!vm.stopped && vm.state.domain === "VTS" && (!vm.media || same())) vm.cellEnded();
  return settle(vm);
}
