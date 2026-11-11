// Builders for hdmv-1 packs made at test time: HDMV's 12-byte commands, buttons, pages, playlists and cells.
import {
  HdmvVm,
  TICKS,
  type HdmvButton,
  type HdmvCell,
  type HdmvPack,
  type HdmvPage,
  type HdmvPlaylist,
} from "../src/hdmvvm";

// ------------------------------------------------------------------ a command encoder (HDMV's 12-byte commands)

export const PSR = (n: number) => (0x80000000 | n) >>> 0;
export const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
export function cmd(
  o: { opCnt?: number; grp: number; sub: number; imm1?: boolean; imm2?: boolean; br?: number; cmp?: number; set?: number },
  dst = 0,
  src = 0,
): string {
  const w =
    ((o.opCnt ?? 0) << 29) |
    (o.grp << 27) |
    (o.sub << 24) |
    ((o.imm1 ? 1 : 0) << 23) |
    ((o.imm2 ? 1 : 0) << 22) |
    ((o.br ?? 0) << 16) |
    ((o.cmp ?? 0) << 8) |
    (o.set ?? 0);
  return hex(w) + hex(dst) + hex(src);
}
export const nop = () => cmd({ grp: 0, sub: 0, br: 0 });
export const goto = (pc: number) => cmd({ opCnt: 1, grp: 0, sub: 0, br: 1, imm1: true }, pc);
export const brk = () => cmd({ grp: 0, sub: 0, br: 2 });
export const jumpObject = (n: number) => cmd({ opCnt: 1, grp: 0, sub: 1, br: 0, imm1: true }, n);
export const jumpTitle = (n: number) => cmd({ opCnt: 1, grp: 0, sub: 1, br: 1, imm1: true }, n);
export const callObject = (n: number) => cmd({ opCnt: 1, grp: 0, sub: 1, br: 2, imm1: true }, n);
export const resume = () => cmd({ grp: 0, sub: 1, br: 4 });
export const playPl = (pl: number) => cmd({ opCnt: 1, grp: 0, sub: 2, br: 0, imm1: true }, pl);
export const playPlPi = (pl: number, item: number) => cmd({ opCnt: 2, grp: 0, sub: 2, br: 1, imm1: true, imm2: true }, pl, item);
export const playPlMk = (pl: number, mark: number) => cmd({ opCnt: 2, grp: 0, sub: 2, br: 2, imm1: true, imm2: true }, pl, mark);
/** play_pl_pm with the mark number in a GPR. */
export const playPlMkGpr = (pl: number, reg: number) => cmd({ opCnt: 2, grp: 0, sub: 2, br: 2, imm1: true }, pl, reg);
export const linkMk = (mark: number) => cmd({ opCnt: 1, grp: 0, sub: 2, br: 5, imm1: true }, mark);
/** if reg == value, run the next command (else skip it). */
export const ifEq = (reg: number, value: number) => cmd({ opCnt: 2, grp: 1, sub: 0, cmp: 2, imm2: true }, reg, value);
export const setGpr = (reg: number, value: number) => cmd({ opCnt: 2, grp: 2, sub: 0, set: 1, imm2: true }, reg, value);
export const addGpr = (reg: number, value: number) => cmd({ opCnt: 2, grp: 2, sub: 0, set: 3, imm2: true }, reg, value);
export const movReg = (dst: number, src: number) => cmd({ opCnt: 2, grp: 2, sub: 0, set: 1 }, dst, src);
/** set_stream: audio and subtitle stream numbers, the subtitle display flag, the IG stream. */
export const setStream = (o: { audio?: number; pg?: number; pgOn?: boolean; ig?: number }) =>
  cmd(
    { opCnt: 2, grp: 2, sub: 1, set: 1, imm1: true, imm2: true },
    (o.audio != null ? 0x80000000 | (o.audio << 16) : 0) | (o.pg != null ? 0x8000 | o.pg | (o.pgOn ? 0x4000 : 0) : 0),
    o.ig != null ? 0x80000000 | (o.ig << 16) : 0,
  );
export const setButtonPage = (button: number | null, page: number | null) =>
  cmd(
    { opCnt: 2, grp: 2, sub: 1, set: 3, imm1: true, imm2: true },
    button != null ? 0x80000000 | button : 0,
    page != null ? 0x80000000 | page : 0,
  );
export const enableButton = (b: number) => cmd({ opCnt: 1, grp: 2, sub: 1, set: 4, imm1: true }, b);
export const disableButton = (b: number) => cmd({ opCnt: 1, grp: 2, sub: 1, set: 5, imm1: true }, b);

// ------------------------------------------------------------------ a pack builder

export const button = (id: number, cmds: string[], o: Partial<HdmvButton> = {}): HdmvButton => ({
  id,
  numeric: null,
  x: 100 * id,
  y: 100,
  auto: false,
  nav: { up: id, down: id, left: id, right: id },
  images: { normal: [`n${id}.png`], selected: [`s${id}.png`], activated: [] },
  sounds: false,
  cmds,
  ...o,
});
/** A page of buttons, each in its own overlap group shown by default. */
export const page = (id: number, buttons: HdmvButton[], o: Partial<HdmvPage> = {}): HdmvPage => ({
  id,
  default_selected: null,
  default_activated: null,
  effects: false,
  bogs: buttons.map((b) => ({ default: b.id, buttons: [b] })),
  ...o,
});
/** A row of buttons, linked left and right. */
export function row(buttons: HdmvButton[]): HdmvButton[] {
  buttons.forEach((b, i) => {
    b.nav.left = buttons[Math.max(i - 1, 0)].id;
    b.nav.right = buttons[Math.min(i + 1, buttons.length - 1)].id;
  });
  return buttons;
}
export const playlist = (o: Partial<HdmvPlaylist> & { secs?: number[] } = {}): HdmvPlaylist => ({
  items: (o.secs ?? [60]).map((s, i) => ({ clip: `0000${i}`, in: 0, out: s * TICKS })),
  marks: [],
  streams: { audio: [], pg: [], ig: [] },
  menus: {},
  ...o,
});
export const ep = (n: number, o: Partial<HdmvCell> = {}): HdmvCell => ({ episode: n, file: `E${n}.mkv`, offset: 0, dur: 1400, ...o });

export function makePack(o: {
  objects: Record<number, string[]>;
  playlists: Record<string, HdmvPlaylist>;
  menus?: HdmvPack["menus"];
  media?: Record<string, Record<number, HdmvCell>>;
  first?: number;
  top?: number;
  titles?: HdmvPack["index"]["titles"];
}): HdmvPack {
  return {
    schema: "hdmv-1",
    disc: { type: "bluray", name: "Test", season: 1 },
    psr: {},
    index: { first_play: o.first ?? 0, top_menu: o.top ?? 1, titles: o.titles ?? [] },
    objects: Object.fromEntries(
      Object.entries(o.objects).map(([k, cmds]) => [k, { resume: false, menu_call_mask: false, title_search_mask: false, cmds }]),
    ),
    playlists: o.playlists,
    menus: o.menus ?? {},
    media: Object.fromEntries(
      Object.entries(o.media ?? {}).map(([pl, cells]) => [
        pl,
        { cells: Object.fromEntries(Object.entries(cells).map(([t, c]) => [String(Number(t) * TICKS), c])) },
      ]),
    ),
  };
}
export const menu = (pages: HdmvPage[]) => ({ clip: "00100", pid: 0x1400, model: "always_on" as const, size: [1920, 1080] as [number, number], pages });
export const withMenu = (key = "m.ig1") => playlist({ menus: { "1": key }, background: { video: "bg.mp4", still: "bg.jpg" } });

export function vmOf(pack: HdmvPack, opts = {}) {
  const log: string[] = [];
  const unsupported: string[] = [];
  const vm = new HdmvVm(pack, { log: (s) => log.push(s), unsupported: (f) => unsupported.push(f), rnd: () => 0, ...opts });
  return { vm, log, unsupported };
}
export const menuOf = (vm: HdmvVm) => {
  if (vm.status.kind !== "menu") throw new Error(`not a menu: ${JSON.stringify(vm.status)}`);
  return vm.status.menu;
};
export const handoffOf = (vm: HdmvVm) => {
  if (vm.status.kind !== "handoff") throw new Error(`not a handoff: ${JSON.stringify(vm.status)}`);
  return vm.status.handoff;
};

