// The Sintel DVD's own navigation, run in the VM. Expected results come from the disc's commands (see
// fixtures/sintel/menu.json, whose "txt" fields spell each command out): first play sets g1 = 1, so the root
// menu PGC 3 routes through PGC 8 to the intro (PGC 9), whose post command links to the main menu (PGC 10:
// Play, Extras, Subtitles). Play sets g3 = 0x102 and VMGM PGC 2 jumps to title 2, the film. The film's post
// command sets g1 = 4, which the root menu routes to the Extras menu (PGC 12).
// Only title 2 is in the fixture's library, as "Sintel (2010).mkv"; every other title is skipped.
import { existsSync } from "node:fs";
import { describe as group, expect, test } from "vitest";
import type { MenuJson, PgcJson } from "../src/dvdvm.js";
import { describe, loadPack, move, playFileOut, press, settle, startVm } from "./helpers.js";

const pack = loadPack("sintel");
const MAIN = (hl: number) => `menu VTSM1 pgc 10 (3 buttons, highlighted ${hl})`;
const EXTRAS = "menu VTSM1 pgc 12 (7 buttons, highlighted 1)";
const FILM = "Sintel (2010).mkv";

group("Sintel: start-up", () => {
  test("first play shows the intro, then the main menu", () => {
    const vm = startVm(pack);
    expect(settle(vm)).toBe("menu");
    expect(describe(vm)).toBe("menu VTSM1 pgc 9 (1 buttons, highlighted 1)");
    vm.cellEnded();
    expect(settle(vm)).toBe("menu");
    expect(describe(vm)).toBe(MAIN(1));
  });

  test("a press during the intro skips to the main menu", () => {
    const vm = startVm(pack);
    settle(vm);
    press(vm, 1);
    expect(describe(vm)).toBe(MAIN(1));
  });

  test("the Title menu key replays the intro", () => {
    const vm = startVm(pack);
    vm.cellEnded();
    settle(vm);
    expect(vm.menuCall("title")).toBe(true);
    settle(vm);
    expect(describe(vm)).toBe("menu VTSM1 pgc 9 (1 buttons, highlighted 1)");
  });
});

group("Sintel: main menu", () => {
  const atMain = () => {
    const vm = startVm(pack);
    vm.cellEnded();
    settle(vm);
    return vm;
  };

  test("arrow moves follow the disc's navigation table and wrap", () => {
    const vm = atMain();
    expect([move(vm, "down"), move(vm, "down"), move(vm, "down")]).toEqual([2, 3, 1]);
    expect(move(vm, "up")).toBe(3);
    expect(move(vm, "right")).toBe(1);
  });

  test("Play starts the film at chapter 1, and the chapters follow the cells", () => {
    const vm = atMain();
    expect(press(vm, 1)).toBe("title");
    expect(describe(vm)).toBe(`title 2 chapter 1: ${FILM} @ 0s, audio default, subs off`);
    vm.cellEnded();
    vm.cellEnded();
    vm.cellEnded();
    expect(describe(vm)).toBe(`title 2 chapter 4: ${FILM} @ 349.97s, audio default, subs off`);
  });

  test("the Menu key mid-film returns to the main menu", () => {
    const vm = atMain();
    press(vm, 1);
    vm.cellEnded();
    expect(vm.menuCall("root")).toBe(true);
    settle(vm);
    expect(describe(vm)).toBe(MAIN(1));
  });

  test("the end of the film goes to the Extras menu; Back returns with Extras highlighted", () => {
    const vm = atMain();
    press(vm, 1);
    expect(playFileOut(vm)).toBe("menu");
    expect(describe(vm)).toBe(EXTRAS);
    press(vm, 7);
    expect(describe(vm)).toBe(MAIN(2));
  });

  test("Subtitles: button 3 sets German subtitles (SPRM2 = 0x47) and plays the film", () => {
    const vm = atMain();
    press(vm, 3);
    expect(describe(vm)).toBe("menu VTSM1 pgc 11 (10 buttons, highlighted 1)");
    press(vm, 3);
    expect(vm.sprm[2]).toBe(0x47);
    expect(describe(vm)).toBe(`title 2 chapter 1: ${FILM} @ 0s, audio default, subs deu`);
  });
});

group("Sintel: titles not in the library", () => {
  test("Extras > Commentary > Durian crew: title 1 is skipped and the disc returns to the Commentary menu", () => {
    const vm = startVm(pack);
    vm.cellEnded();
    settle(vm);
    press(vm, 2);
    expect(describe(vm)).toBe(EXTRAS);
    press(vm, 2);
    expect(describe(vm)).toBe("menu VTSM1 pgc 13 (9 buttons, highlighted 1)");
    const skipped: string[] = [];
    const b = vm.cell!.menu!.buttons.find((x) => x.n === 3)!;
    vm.activate(b);
    expect(vm.sprm[1]).toBe(2); // the commentary's audio stream
    expect(settle(vm, skipped)).toBe("menu");
    expect(skipped).toEqual([1, 2, 3, 4, 5, 6, 7].map((c) => `VTS1 pgc 1 (title 1, chapter ${c}) cell ${c}`));
    expect(describe(vm)).toBe("menu VTSM1 pgc 13 (9 buttons, highlighted 1)");
  });
});

group("Sintel: fixture", () => {
  test("every file menu.json names is in the fixture", () => {
    const pgcs: PgcJson[] = [pack.vmg.fp, ...Object.values(pack.vmg.menus).flat()];
    for (const v of Object.values(pack.vts)) pgcs.push(...Object.values(v.menus).flat(), ...v.title_pgcs);
    const menus = pgcs.flatMap((p) => p.cells.map((c) => c.menu)).filter((m): m is MenuJson => !!m);
    const files = menus.flatMap((m) => [
      m.background?.image,
      m.background?.audio,
      m.background?.video,
      m.overlay,
      ...m.buttons.flatMap((b) => [b.selected, b.activated]),
    ]);
    const named = files.filter((f): f is string => !!f);
    expect(menus.length).toBe(5);
    expect(named.length).toBeGreaterThan(0);
    const missing = named.filter((f) => !existsSync(new URL(`../fixtures/sintel/${f}`, import.meta.url)));
    expect(missing).toEqual([]);
  });

  test("the fixture has no menu videos", () => {
    expect(JSON.stringify(pack)).not.toMatch(/"video":/);
  });
});
