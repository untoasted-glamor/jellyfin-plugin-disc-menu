import { describe, expect, it } from "vitest";
import { HdmvVm, TICKS, decode, langCode, type HdmvButton, type HdmvPage } from "../src/hdmvvm";
import {
  PSR,
  addGpr,
  brk,
  button,
  callObject,
  cmd,
  disableButton,
  enableButton,
  ep,
  goto,
  handoffOf,
  ifEq,
  jumpObject,
  jumpTitle,
  linkMk,
  makePack,
  menu,
  menuOf,
  movReg,
  nop,
  page,
  playPl,
  playPlMk,
  playPlMkGpr,
  playPlPi,
  playlist,
  resume,
  row,
  setButtonPage,
  setGpr,
  setStream,
  vmOf,
  withMenu,
} from "./hdmvbuild";


// ------------------------------------------------------------------ tests

describe("command decoding", () => {
  it("reads the fields of a 12-byte command", () => {
    const c = decode(playPlMk(8, 3));
    expect(c).toMatchObject({ opCnt: 2, grp: 0, sub: 2, br: 2, imm1: true, imm2: true, dst: 8, src: 3 });
    expect(decode(ifEq(PSR(4), 0xffff))).toMatchObject({ grp: 1, cmp: 2, imm1: false, imm2: true, dst: PSR(4) });
  });
  it("packs a language the way PSR 16 holds it", () => {
    expect(langCode("eng")).toBe(0x656e67);
    expect(langCode("x")).toBe(0xffffff);
  });
});

describe("registers", () => {
  it("starts from libbluray's values, the viewer's languages, then the pack's overrides", () => {
    const pack = makePack({ objects: { 0: [] }, playlists: {} });
    pack.psr = { "20": 2 };
    const { vm } = vmOf(pack, { audioLang: "jpn", subtitleLang: "fre" });
    expect(vm.psr[4]).toBe(0xffff);
    expect(vm.psr[16]).toBe(langCode("jpn"));
    expect(vm.psr[18]).toBe(langCode("jpn"));
    expect(vm.psr[17]).toBe(langCode("fre"));
    expect(vm.psr[20]).toBe(2);
  });
  it("does arithmetic, compares and gotos, and leaves PSRs alone", () => {
    const pack = makePack({
      objects: {
        0: [
          setGpr(1, 5), addGpr(1, 7), // 0, 1: r1 = 12
          cmd({ opCnt: 2, grp: 2, sub: 0, set: 5, imm2: true }, 1, 3), // r1 *= 3 -> 36
          cmd({ opCnt: 2, grp: 2, sub: 0, set: 4, imm2: true }, 2, 9), // r2 = 0 - 9 -> 0 (no wrap)
          cmd({ opCnt: 2, grp: 2, sub: 0, set: 8, imm2: true }, 3, 6), // r3 = rnd 1..6 -> 1
          cmd({ opCnt: 2, grp: 2, sub: 0, set: 1, imm2: true }, PSR(4), 7), // a PSR is read-only
          ifEq(1, 36), goto(9), // 6, 7
          setGpr(4, 1), // 8: skipped
          movReg(5, PSR(4)), // 9
          brk(),
        ],
      },
      playlists: {},
    });
    const { vm } = vmOf(pack);
    expect(vm.start()).toEqual({ kind: "stopped", why: "break" });
    expect([vm.gpr[1], vm.gpr[2], vm.gpr[3], vm.gpr[4], vm.gpr[5]]).toEqual([36, 0, 1, 0, 0xffff]);
  });
  it("stops a loop at the step limit", () => {
    const { vm } = vmOf(makePack({ objects: { 0: [goto(0)] }, playlists: {} }));
    expect(vm.start()).toEqual({ kind: "stopped", why: "step limit" });
  });
});

describe("first play and the top menu", () => {
  it("first play jumps to the top menu title, which shows the menu", () => {
    const pack = makePack({
      first: 0,
      top: 1,
      objects: { 0: [ifEq(PSR(4), 0xffff), jumpTitle(0)], 1: [playPl(5), jumpObject(1)] },
      playlists: { "00005": withMenu() },
      menus: { "m.ig1": menu([page(0, row([button(1, []), button(2, [])]))]) },
    });
    const { vm } = vmOf(pack);
    const s = vm.start();
    expect(s.kind).toBe("menu");
    expect(menuOf(vm)).toMatchObject({ playlist: "00005", key: "m.ig1", selected: 1 });
    expect(vm.psr[4]).toBe(0);
    expect(vm.shownButtons().map((b) => [b.button.id, b.state, b.image])).toEqual([
      [1, "selected", "s1.png"],
      [2, "normal", "n2.png"],
    ]);
  });
  it("skips a warning playlist with no media and no menu, logging it", () => {
    const pack = makePack({
      objects: { 0: [playPl(1), playPl(5)] },
      playlists: { "00001": playlist({ secs: [12] }), "00005": withMenu() },
      menus: { "m.ig1": menu([page(0, [button(1, [])])]) },
    });
    const { vm, log } = vmOf(pack);
    expect(vm.start().kind).toBe("menu");
    expect(log).toContain("play_pl 00001 (12.0s): no media and no menu, plays through");
  });
  it("the top menu key runs the index's top menu object", () => {
    const pack = makePack({
      objects: { 0: [playPl(2)], 1: [playPl(5)] },
      playlists: { "00002": playlist(), "00005": withMenu() },
      media: { "00002": { 0: ep(1) } },
      menus: { "m.ig1": menu([page(0, [button(1, [])])]) },
    });
    const { vm } = vmOf(pack);
    expect(vm.start().kind).toBe("handoff");
    expect(vm.topMenu().kind).toBe("menu");
  });
  it("a BD-J title is reported and stops", () => {
    const pack = makePack({ objects: { 0: [jumpTitle(1)] }, playlists: {}, titles: [{ n: 1, bdj: true }] });
    const { vm, unsupported } = vmOf(pack);
    expect(vm.start()).toEqual({ kind: "stopped", why: "title 1 can't be played" });
    expect(unsupported).toEqual(["BD-J title 1"]);
  });
  it("a button's call_object comes back to the menu object, which goes on", () => {
    // Object 0 shows the menu, then sets GPR 2 once its playlist ends; the button calls object 3, which resumes.
    const pk = makePack({
      objects: { 0: [playPl(5), setGpr(2, 1), brk()], 3: [setGpr(3, 1), resume()] },
      playlists: { "00005": withMenu() },
      menus: { "m.ig1": menu([page(0, [button(1, [callObject(3)])])]) },
    });
    const { vm } = vmOf(pk);
    vm.start();
    vm.activate();
    expect([vm.gpr[3], vm.gpr[2]]).toEqual([1, 1]);
    expect(vm.status).toEqual({ kind: "stopped", why: "break" });
  });
  it("call_object and resume come back after the call", () => {
    const pack = makePack({ objects: { 0: [callObject(2), playPl(5)], 2: [setGpr(9, 1), resume()] }, playlists: { "00005": withMenu() }, menus: { "m.ig1": menu([page(0, [button(1, [])])]) } });
    const { vm } = vmOf(pack);
    expect(vm.start().kind).toBe("menu");
    expect(vm.gpr[9]).toBe(1);
  });
});

describe("menu navigation", () => {
  const grid = () => {
    const b = [1, 2, 3, 4].map((id) => button(id, [setGpr(id, 1)]));
    // 1 2
    // 3 4
    b[0].nav = { up: 1, down: 3, left: 1, right: 2 };
    b[1].nav = { up: 2, down: 4, left: 1, right: 2 };
    b[2].nav = { up: 1, down: 3, left: 3, right: 4 };
    b[3].nav = { up: 2, down: 4, left: 3, right: 4 };
    b[3].numeric = 4;
    return b;
  };
  const pack = (buttons: HdmvButton[], o: Partial<HdmvPage> = {}, extraPages: HdmvPage[] = []) =>
    makePack({
      objects: { 0: [playPl(5)] },
      playlists: { "00005": withMenu() },
      menus: { "m.ig1": menu([page(0, buttons, o), ...extraPages]) },
    });

  it("arrows follow the neighbour table", () => {
    const { vm } = vmOf(pack(grid()));
    vm.start();
    vm.move("right");
    expect(menuOf(vm).selected).toBe(2);
    vm.move("down");
    expect(menuOf(vm).selected).toBe(4);
    vm.move("down");
    expect(menuOf(vm).selected).toBe(4);
    expect(vm.psr[10]).toBe(4);
  });
  it("selects the page's default button, then OK runs its commands", () => {
    const { vm } = vmOf(pack(grid(), { default_selected: 3 }));
    vm.start();
    expect(menuOf(vm).selected).toBe(3);
    vm.activate();
    expect(vm.gpr[3]).toBe(1);
  });
  it("a number key selects the button with that number; OK runs it", () => {
    const { vm } = vmOf(pack(grid()));
    vm.start();
    vm.number(4);
    expect(menuOf(vm).selected).toBe(4);
    expect(vm.gpr[4]).toBe(0);
    vm.number(7);
    expect(menuOf(vm).selected).toBe(4);
    vm.activate();
    expect(vm.gpr[4]).toBe(1);
  });
  it("a number key runs an auto-action button", () => {
    const b = grid();
    b[3].auto = true;
    const { vm } = vmOf(pack(b));
    vm.start();
    vm.number(4);
    expect(vm.gpr[4]).toBe(1);
  });
  it("a page's default button wins over PSR 10; PSR 10 wins over the first button", () => {
    // A movie object sets PSR 10 before showing the menu (set_button_page in a movie object only sets registers).
    const mk = (def: number | null) =>
      makePack({
        objects: { 0: [setButtonPage(3, null), playPl(5)] },
        playlists: { "00005": withMenu() },
        menus: { "m.ig1": menu([page(0, grid(), { default_selected: def })]) },
      });
    const a = vmOf(mk(2));
    a.vm.start();
    expect(menuOf(a.vm).selected).toBe(2);
    const b = vmOf(mk(null));
    b.vm.start();
    expect(menuOf(b.vm).selected).toBe(3);
  });
  it("arrows skip to nothing that is not shown", () => {
    const b = grid();
    const p = page(0, b);
    p.bogs[1].default = null; // button 2's group shows nothing
    const pk = makePack({ objects: { 0: [playPl(5)] }, playlists: { "00005": withMenu() }, menus: { "m.ig1": menu([p]) } });
    const { vm } = vmOf(pk);
    vm.start();
    vm.move("right");
    expect(menuOf(vm).selected).toBe(1);
    expect(vm.shownButtons().map((s) => s.button.id)).toEqual([1, 3, 4]);
  });
  it("set_button_page goes to another page and selects there", () => {
    const b = grid();
    b[1].cmds = [setButtonPage(null, 1)];
    const p1 = page(1, row([button(10, []), button(11, [])]), { default_selected: 11 });
    const { vm } = vmOf(pack(b, {}, [p1]));
    vm.start();
    vm.move("right");
    vm.activate();
    expect(menuOf(vm).page.id).toBe(1);
    expect(menuOf(vm).selected).toBe(11);
    expect(vm.psr[11]).toBe(1);
  });
  it("set_button_page with a button selects it on the new page", () => {
    const b = grid();
    b[0].cmds = [setButtonPage(10, 1)];
    const p1 = page(1, row([button(10, []), button(11, [])]), { default_selected: 11 });
    const { vm } = vmOf(pack(b, {}, [p1]));
    vm.start();
    vm.activate();
    expect(menuOf(vm).selected).toBe(10);
  });
  it("set_button_page ends the button's commands", () => {
    const b = grid();
    b[0].cmds = [setButtonPage(2, null), setGpr(50, 1)];
    const { vm } = vmOf(pack(b));
    vm.start();
    vm.activate();
    expect(menuOf(vm).selected).toBe(2);
    expect(vm.gpr[50]).toBe(0);
  });
  it("an auto-action logic page runs on entry and goes on to the page it picks", () => {
    // Page 1 is a logic page: its one button is auto-action and picks page 2 or 3 by GPR 7.
    const b = grid();
    b[0].cmds = [setGpr(7, 1), setButtonPage(null, 1)];
    const logic = page(1, [button(20, [ifEq(7, 1), setButtonPage(null, 3), setButtonPage(null, 2)], { auto: true })]);
    const p2 = page(2, [button(30, [])]);
    const p3 = page(3, [button(40, [])]);
    const { vm } = vmOf(pack(b, {}, [logic, p2, p3]));
    vm.start();
    vm.activate();
    expect(menuOf(vm).page.id).toBe(3);
    expect(menuOf(vm).selected).toBe(40);
  });
  it("a page's default-activated button is reported, not run (libbluray leaves it out too)", () => {
    const b = grid();
    b[0].cmds = [setButtonPage(null, 1)];
    const p1 = page(1, [button(20, [setGpr(60, 1)]), button(21, [])], { default_activated: 20 });
    const { vm, unsupported } = vmOf(pack(b, {}, [p1]));
    vm.start();
    vm.activate();
    expect(vm.gpr[60]).toBe(0);
    expect(unsupported).toContain("default-activated buttons");
  });
  it("set_button_page naming the current page is ignored, button and all", () => {
    const b = grid();
    b[0].cmds = [setButtonPage(4, 0)];
    const { vm } = vmOf(pack(b));
    vm.start();
    vm.activate();
    expect(menuOf(vm).selected).toBe(1);
  });
  it("set_button_page to a page that does not exist is ignored", () => {
    const b = grid();
    b[0].cmds = [setButtonPage(null, 9)];
    const { vm } = vmOf(pack(b));
    vm.start();
    vm.activate();
    expect(menuOf(vm).page.id).toBe(0);
  });
  it("set_button_page with a button shows it in its group", () => {
    // Group 0 holds buttons 1 and 5; set_button_page(5) swaps 5 in and selects it.
    const b = grid();
    const p = page(0, b);
    p.bogs[0].buttons.push(button(5, []));
    b[1].cmds = [setButtonPage(5, null)];
    const pk = makePack({ objects: { 0: [playPl(5)] }, playlists: { "00005": withMenu() }, menus: { "m.ig1": menu([p]) } });
    const { vm } = vmOf(pk);
    vm.start();
    vm.move("right");
    vm.activate();
    expect(menuOf(vm).selected).toBe(5);
    expect(vm.shownButtons().map((s) => s.button.id)).toEqual([5, 2, 3, 4]);
  });
  it("disabling the selected button selects by the page's rules when the commands end", () => {
    const b = grid();
    b[1].cmds = [disableButton(2)];
    const { vm } = vmOf(pack(b, { default_selected: 3 }));
    vm.start();
    vm.move("up"); // 3 -> 1
    vm.move("right"); // 1 -> 2
    vm.activate();
    expect(menuOf(vm).selected).toBe(3);
    expect(vm.psr[10]).toBe(3);
  });
  it("enabling another button in the selected button's group selects it", () => {
    const b = grid();
    const p = page(0, b);
    p.bogs[0].buttons.push(button(5, []));
    b[0].cmds = [enableButton(5)];
    const pk = makePack({ objects: { 0: [playPl(5)] }, playlists: { "00005": withMenu() }, menus: { "m.ig1": menu([p]) } });
    const { vm } = vmOf(pk);
    vm.start();
    vm.activate();
    expect(menuOf(vm).selected).toBe(5);
  });
  it("enable and disable do nothing in a movie object", () => {
    const pk = makePack({
      objects: { 0: [playPl(5)], 1: [disableButton(2), playPl(5)] },
      playlists: { "00005": withMenu() },
      menus: { "m.ig1": menu([page(0, row([button(1, [jumpObject(1)]), button(2, [])]))]) },
    });
    const { vm } = vmOf(pk);
    vm.start();
    vm.activate();
    expect(vm.shownButtons().map((s) => s.button.id)).toEqual([1, 2]);
  });
  it("an auto-action button that PSR 10 points at after an episode does not replay it", () => {
    // D2's shape: the episode button stores its mark in GPR 3553 and selects auto-action button 3 on the logic page
    // 0, which jumps to title 1; title 1 plays the episode, clears GPR 3553 and returns to the top menu. Page 0's
    // default button 0 (auto-action) then shows the main menu, page 2.
    const logic = page(
      0,
      [
        button(0, [setButtonPage(10, 2)], { auto: true }),
        button(3, [ifEq(PSR(4), 1), linkMk(0), jumpTitle(1)], { auto: true }),
      ],
      { default_selected: 0 },
    );
    const main = page(2, [button(10, [setGpr(3553, 1), setButtonPage(3, 0)])]);
    const pk = makePack({
      top: 1,
      objects: { 0: [jumpTitle(0)], 1: [playPl(1)], 2: [playPlMkGpr(8, 3553), setGpr(3553, 0), jumpTitle(0)] },
      titles: [{ n: 1, object: 2 }],
      playlists: {
        "00001": withMenu(),
        "00008": playlist({ secs: [100, 100], marks: [{ type: "entry", item: 0, time: 0, at: 0 }, { type: "entry", item: 1, time: 0, at: 100 * TICKS }] }),
      },
      menus: { "m.ig1": menu([logic, main]) },
      media: { "00008": { 0: ep(1, { dur: 100 }), 100: ep(2, { dur: 100 }) } },
    });
    const { vm } = vmOf(pk);
    vm.start();
    expect(menuOf(vm).page.id).toBe(2);
    vm.activate();
    expect(handoffOf(vm).cell.episode).toBe(2);
    vm.ended();
    expect(menuOf(vm).page.id).toBe(2);
    expect(menuOf(vm).selected).toBe(10);
  });
  it("selecting an auto-action button runs it", () => {
    const b = grid();
    b[1].auto = true;
    const { vm } = vmOf(pack(b));
    vm.start();
    vm.move("right");
    expect(vm.gpr[2]).toBe(1);
  });
  it("auto-action pages that loop stop", () => {
    const b = grid();
    b[0].cmds = [setButtonPage(null, 1)];
    const p1 = page(1, [button(20, [setButtonPage(null, 2)], { auto: true })]);
    const p2 = page(2, [button(30, [setButtonPage(null, 1)], { auto: true })]);
    const { vm, log } = vmOf(pack(b, {}, [p1, p2]));
    vm.start();
    vm.activate();
    expect(vm.status.kind).toBe("menu");
    expect(log).toContain("auto-action buttons loop; stopped following them");
  });
  it("enable and disable change which button a group shows", () => {
    // Group 0 holds buttons 1 and 5 (5 hidden); button 2 swaps them.
    const b = grid();
    const p = page(0, b);
    p.bogs[0].buttons.push(button(5, []));
    b[1].cmds = [disableButton(1), enableButton(5)];
    const pk = makePack({ objects: { 0: [playPl(5)] }, playlists: { "00005": withMenu() }, menus: { "m.ig1": menu([p]) } });
    const { vm } = vmOf(pk);
    vm.start();
    vm.move("right");
    vm.activate();
    expect(vm.shownButtons().map((s) => s.button.id)).toEqual([5, 2, 3, 4]);
  });
  it("the IG stream PSR 0 picks chooses the menu", () => {
    const pl = playlist({ menus: { "1": "m.ig1", "2": "m.ig2" }, background: { video: "bg.mp4", still: "bg.jpg" } });
    const pk = makePack({
      objects: { 0: [setStream({ ig: 2 }), playPl(5)] },
      playlists: { "00005": pl },
      menus: { "m.ig1": menu([page(0, [button(1, [])])]), "m.ig2": menu([page(0, [button(2, [])])]) },
    });
    const { vm } = vmOf(pk);
    vm.start();
    expect(menuOf(vm).key).toBe("m.ig2");
    expect(menuOf(vm).selected).toBe(2);
  });
  it("reports features it leaves out once each", () => {
    const b = grid();
    b[0].sounds = true;
    b[1].sounds = true;
    b[2].images.normal = ["a.png", "b.png"];
    const { vm, unsupported } = vmOf(pack(b, { effects: true }));
    vm.start();
    expect(unsupported.sort()).toEqual(["animated buttons", "button sounds", "page effects"]);
  });
  it("a pop-up menu is reported and its playlist plays through", () => {
    const pk = makePack({
      objects: { 0: [playPl(3), setGpr(1, 1)] },
      playlists: { "00003": playlist({ menus: { "1": "p.ig1" } }) },
      menus: { "p.ig1": { clip: "00003", pid: 0x1400, model: "popup", omitted: true } },
    });
    const { vm, unsupported } = vmOf(pk);
    vm.start();
    expect(unsupported).toEqual(["pop-up menu p.ig1"]);
    expect(vm.gpr[1]).toBe(1);
  });
});

describe("set_stream", () => {
  it("takes stream numbers from GPRs, keeping the operand's flags", () => {
    const pk = makePack({
      objects: {
        0: [
          setGpr(20, 2), setGpr(21, 3), setGpr(22, 2),
          // audio from GPR 20, subtitles (shown) from GPR 21; IG from GPR 22.
          cmd({ opCnt: 2, grp: 2, sub: 1, set: 1 }, (0x80000000 | (20 << 16) | 0x8000 | 0x4000 | 21) >>> 0, (0x80000000 | (22 << 16)) >>> 0),
          brk(),
        ],
      },
      playlists: {},
    });
    const { vm } = vmOf(pk);
    vm.start();
    expect(vm.psr[1]).toBe(2);
    expect(vm.psr[2]).toBe((0x80000000 | 0x0fff0000 | 3) >>> 0);
    expect(vm.psr[0]).toBe(2);
  });
});

describe("handoffs", () => {
  const episodeMenu = (cmdsFor: (i: number) => string[]) =>
    makePack({
      objects: { 0: [playPl(5), jumpObject(0)], 1: [playPl(5)] },
      playlists: {
        "00005": withMenu(),
        "00010": playlist({
          secs: [90, 1400],
          streams: {
            audio: [
              { n: 1, lang3: "jpn", codec: "lpcm", channels: 2 },
              { n: 2, lang3: "eng", codec: "ac3", channels: 6 },
            ],
            pg: [{ n: 1, lang3: "eng", sidecar: "E10.eng.srt" }],
            ig: [],
          },
        }),
        "00008": playlist({
          secs: [1400, 1400, 1400],
          marks: [
            { type: "entry", item: 0, time: 0, at: 0 },
            { type: "entry", item: 1, time: 0, at: 1400 * TICKS },
            { type: "entry", item: 2, time: 30 * TICKS, at: 2830 * TICKS },
          ],
        }),
        "00021": playlist({ secs: [120] }),
      },
      menus: { "m.ig1": menu([page(0, row([1, 2, 3, 4].map((i) => button(i, cmdsFor(i)))))]) },
      media: {
        "00010": { 0: ep(10, { offset: 0, dur: 1490 }) },
        "00008": { 0: ep(10), 1400: ep(11), 2800: ep(12) },
        "00021": { 0: { extra: "trailers/Trailers.mkv", file: "Trailers.mkv", offset: 0, dur: 120 } },
      },
    });

  it("an episode button hands off with the streams set_stream chose", () => {
    const { vm } = vmOf(episodeMenu(() => [setStream({ audio: 2, pg: 1, pgOn: true }), playPl(10)]));
    vm.start();
    vm.activate();
    const h = handoffOf(vm);
    expect(h).toMatchObject({ playlist: "00010", start: 0, offset: 0, queue: [] });
    expect(h.cell.episode).toBe(10);
    expect(h.audio?.lang3).toBe("eng");
    expect(h.pg?.sidecar).toBe("E10.eng.srt");
  });
  it("subtitles stay off without the display flag", () => {
    const { vm } = vmOf(episodeMenu(() => [setStream({ audio: 1, pg: 1 }), playPl(10)]));
    vm.start();
    vm.activate();
    expect(handoffOf(vm).pg).toBeNull();
    expect(handoffOf(vm).audio?.lang3).toBe("jpn");
  });
  it("an audio stream the playlist lacks falls back to the viewer's language", () => {
    const { vm } = vmOf(episodeMenu(() => [setStream({ audio: 0, pg: 9, pgOn: true }), playPl(10)]), { audioLang: "eng" });
    vm.start();
    vm.activate();
    expect(handoffOf(vm).audio?.n).toBe(2);
    expect(handoffOf(vm).pg?.n).toBe(1);
  });
  it("a play-all hands off its first cell and queues the rest", () => {
    const { vm } = vmOf(episodeMenu(() => [playPl(8)]));
    vm.start();
    vm.activate();
    const h = handoffOf(vm);
    expect(h.cell.episode).toBe(10);
    expect(h.queue.map((c) => c.episode)).toEqual([11, 12]);
  });
  it("a chapter mark starts inside its cell, with the offset into the file", () => {
    const { vm } = vmOf(episodeMenu((i) => [playPlMk(8, i - 1)]));
    vm.start();
    vm.move("right");
    vm.move("right");
    vm.activate();
    const h = handoffOf(vm);
    expect(h.cell.episode).toBe(12);
    expect(h.offset).toBe(30);
    expect(h.queue).toEqual([]);
  });
  it("a play item starts at its item", () => {
    const { vm } = vmOf(episodeMenu(() => [playPlPi(8, 1)]));
    vm.start();
    vm.activate();
    expect(handoffOf(vm).cell.episode).toBe(11);
    expect(handoffOf(vm).queue.map((c) => c.episode)).toEqual([12]);
  });
  it("an extra hands off by its folder path", () => {
    const { vm } = vmOf(episodeMenu(() => [playPl(21)]));
    vm.start();
    vm.activate();
    expect(handoffOf(vm).cell.extra).toBe("trailers/Trailers.mkv");
  });
  it("one OP clip shared by two episode playlists: each hands off its own episode", () => {
    // Playlists 00011 and 00012 both open on the same 90 s OP clip, then their episode; each is mapped whole.
    const pk = makePack({
      objects: { 0: [playPl(5)] },
      playlists: {
        "00005": withMenu(),
        "00011": playlist({ secs: [90, 1400] }),
        "00012": playlist({ secs: [90, 1400] }),
      },
      menus: { "m.ig1": menu([page(0, row([button(1, [playPl(11)]), button(2, [playPl(12)])]))]) },
      media: { "00011": { 0: ep(11) }, "00012": { 0: ep(12) } },
    });
    pk.playlists["00012"].items[0].clip = pk.playlists["00011"].items[0].clip;
    const { vm } = vmOf(pk);
    vm.start();
    vm.move("right");
    vm.activate();
    expect(handoffOf(vm).cell.episode).toBe(12);
  });
  it("a start past the end of every cell does not hand off", () => {
    const pk = makePack({
      objects: { 0: [playPlPi(8, 1), setGpr(1, 1)] },
      playlists: { "00008": playlist({ secs: [100, 50] }) },
      media: { "00008": { 0: ep(1, { dur: 100 }) } },
    });
    const { vm } = vmOf(pk);
    expect(vm.start().kind).toBe("stopped");
    expect(vm.gpr[1]).toBe(1);
  });
  it("after a handoff ends, the movie object goes on", () => {
    // Object 1's episode playlist ends, then it sets GPR 3 and returns to the menu.
    const pk = makePack({
      objects: { 0: [playPl(5)], 1: [playPl(10), setGpr(3, 1), playPl(5)] },
      playlists: { "00005": withMenu(), "00010": playlist() },
      menus: { "m.ig1": menu([page(0, [button(1, [jumpObject(1)])])]) },
      media: { "00010": { 0: ep(10) } },
    });
    const { vm } = vmOf(pk);
    vm.start();
    vm.activate();
    expect(vm.status.kind).toBe("handoff");
    expect(vm.ended().kind).toBe("menu");
    expect(vm.gpr[3]).toBe(1);
  });
  it("a button's playlist that plays through lets the menu's object go on", () => {
    const pk = makePack({
      objects: { 0: [playPl(5), setGpr(4, 1), playPl(6)] },
      playlists: { "00005": withMenu(), "00006": withMenu("n.ig1"), "00007": playlist() },
      menus: { "m.ig1": menu([page(0, [button(1, [playPl(7)])])]), "n.ig1": menu([page(0, [button(9, [])])]) },
    });
    const { vm } = vmOf(pk);
    vm.start();
    vm.activate();
    expect(menuOf(vm).key).toBe("n.ig1");
    expect(vm.gpr[4]).toBe(1);
  });
  it("link_mk in the menu's own playlist keeps the menu", () => {
    const pl = withMenu();
    pl.marks = [{ type: "entry", item: 0, time: 0, at: 0 }, { type: "entry", item: 0, time: 30 * TICKS, at: 30 * TICKS }];
    const pk = makePack({
      objects: { 0: [playPl(5)] },
      playlists: { "00005": pl },
      menus: { "m.ig1": menu([page(0, row([button(1, [linkMk(1)]), button(2, [])]))]) },
    });
    const { vm } = vmOf(pk);
    vm.start();
    vm.activate();
    expect(menuOf(vm).selected).toBe(1);
  });
  it("a missing playlist plays through, logged", () => {
    const pk = makePack({ objects: { 0: [playPl(77), nop(), brk()] }, playlists: {} });
    const { vm, log } = vmOf(pk);
    expect(vm.start().kind).toBe("stopped");
    expect(log).toContain("play_pl 00077: not in the pack; plays through");
  });
});
