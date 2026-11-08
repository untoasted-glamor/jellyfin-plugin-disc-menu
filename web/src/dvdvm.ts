// A DVD-Video virtual machine over a menu pack (menu.json, schema "dvd-1").
// Command evaluation follows libdvdnav's decoder.c and the play state machine follows vm.c
// (play_PGC / play_PG / play_Cell / play_Cell_post / play_PGC_post / process_command), so a disc's
// own compiled navigation runs unchanged. Not done: angle blocks, GPRM counter mode (kept as a
// plain register), the SPRM9 navigation timer, parental checks and user-operation masks.

export type Domain = "FP" | "VMGM" | "VTSM" | "VTS";

export interface ButtonJson {
  n: number;
  rect: [number, number, number, number];
  nav: { up: number; down: number; left: number; right: number };
  auto: number;
  cmd: string;
  txt: string;
  selected?: string;
  activated?: string;
}
export interface MenuJson {
  size: [number, number];
  aspect: string;
  background: { image?: string; audio?: string; video?: string } | null;
  overlay: string | null;
  buttons: ButtonJson[];
  forced_select?: number;
  forced_action?: number;
}
export interface CellJson {
  dur: number;
  still: number;
  cmd: number;
  menu?: MenuJson | null;
}
export interface PgcJson {
  entry: string | null;
  next: number;
  prev: number;
  goup: number;
  still: number;
  program_map: number[];
  pre: string[];
  post: string[];
  cellcmds: string[];
  txt: { pre: string[]; post: string[]; cellcmds: string[] };
  cells: CellJson[];
}
/** Where a title cell's video lives: a series episode (by number) or a movie file (by name), and where in it. */
export interface MediaCell {
  episode?: number;
  offset: number;
  file: string;
}
export interface Pack {
  schema: string;
  /** season is set for a series disc and absent for a movie. */
  disc: { type: string; name: string; season?: number };
  menu_lang: string;
  vmg: { fp: PgcJson; menus: Record<string, PgcJson[]>; titles: { vts: number; ttn: number; chapters: number }[] };
  vts: Record<
    string,
    {
      audio: { codec: string; lang: string; lang3: string; channels: number }[];
      subp: { lang: string; lang3: string; sidecar?: string }[];
      menus: Record<string, PgcJson[]>;
      title_pgcs: PgcJson[];
      ptt: [number, number][][];
    }
  >;
  media: Record<string, { cells: Record<string, MediaCell> }>;
}

type LinkCmd =
  | "PlayThis"
  | "LinkNoLink" | "LinkTopC" | "LinkNextC" | "LinkPrevC" | "LinkTopPG" | "LinkNextPG" | "LinkPrevPG"
  | "LinkTopPGC" | "LinkNextPGC" | "LinkPrevPGC" | "LinkGoUpPGC" | "LinkTailPGC" | "LinkRSM"
  | "LinkPGCN" | "LinkPTTN" | "LinkPGN" | "LinkCN" | "Exit" | "JumpTT" | "JumpVTS_TT" | "JumpVTS_PTT"
  | "JumpSS_FP" | "JumpSS_VMGM_MENU" | "JumpSS_VTSM" | "JumpSS_VMGM_PGC"
  | "CallSS_FP" | "CallSS_VMGM_MENU" | "CallSS_VTSM" | "CallSS_VMGM_PGC";

interface Link {
  cmd: LinkCmd;
  d1: number;
  d2: number;
  d3: number;
}

const SUBINS: Record<number, LinkCmd> = {
  0: "LinkNoLink", 1: "LinkTopC", 2: "LinkNextC", 3: "LinkPrevC", 5: "LinkTopPG", 6: "LinkNextPG",
  7: "LinkPrevPG", 9: "LinkTopPGC", 10: "LinkNextPGC", 11: "LinkPrevPGC", 12: "LinkGoUpPGC",
  13: "LinkTailPGC", 16: "LinkRSM",
};
const MENU_ID: Record<string, number> = { title: 2, root: 3, subpicture: 4, audio: 5, angle: 6, chapter: 7 };

const link = (cmd: LinkCmd, d1 = 0, d2 = 0, d3 = 0): Link => ({ cmd, d1, d2, d3 });

/** One 8-byte VM command. */
class Command {
  private readonly v: bigint;
  constructor(hex: string) {
    this.v = BigInt("0x" + hex);
  }
  bits(start: number, count: number): number {
    return Number((this.v >> BigInt(start - count + 1)) & ((1n << BigInt(count)) - 1n));
  }
}

const cmdCache = new Map<string, Command>();
function command(hex: string): Command {
  let c = cmdCache.get(hex);
  if (!c) cmdCache.set(hex, (c = new Command(hex)));
  return c;
}

export interface VmState {
  domain: Domain;
  vtsN: number;
  pgcN: number;
  pgN: number;
  cellN: number;
  pgc: PgcJson;
}

export class DvdVm {
  readonly gprm = new Uint16Array(16);
  readonly gprmCounter = new Uint8Array(16);
  readonly sprm = new Uint16Array(24);
  stopped = false;
  state!: VmState;
  private rsm: { vtsN: number; pgcN: number; cellN: number; regs: number[] } | null = null;
  private readonly log: (s: string) => void;
  private readonly rnd: () => number;
  private steps = 0;

  constructor(
    readonly pack: Pack,
    opts: { log?: (s: string) => void; rnd?: () => number } = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.rnd = opts.rnd ?? Math.random;
    const lang = pack.menu_lang || "en";
    this.sprm[0] = (lang.charCodeAt(0) << 8) | lang.charCodeAt(1);
    this.sprm[1] = 15;
    this.sprm[2] = 62;
    this.sprm[3] = 1;
    this.sprm[4] = 1;
    this.sprm[5] = 1;
    this.sprm[7] = 1;
    this.sprm[8] = 1 << 10;
    this.sprm[12] = ("U".charCodeAt(0) << 8) | "S".charCodeAt(0);
    this.sprm[13] = 15;
    this.sprm[14] = 0x100;
    this.sprm[15] = 0x7cfc;
    this.sprm[16] = this.sprm[0];
    this.sprm[18] = this.sprm[0];
    this.sprm[20] = 1;
  }

  // ------------------------------------------------------------------ public API

  start(): void {
    this.state = { domain: "FP", vtsN: 0, pgcN: 0, pgN: 1, cellN: 0, pgc: this.pack.vmg.fp };
    this.log("start: first play PGC");
    this.process(this.playPGC());
  }

  /** The cell to present now (the VM is waiting for cellEnded() or a button). */
  get cell(): CellJson | null {
    if (this.stopped) return null;
    return this.state.pgc.cells[this.state.cellN - 1] ?? null;
  }

  get highlighted(): number {
    return this.sprm[8] >> 10;
  }

  /** Where this title cell's video lives, if the pack maps it. */
  get media(): MediaCell | null {
    if (this.state.domain !== "VTS") return null;
    return this.pack.media[`${this.state.vtsN}:${this.state.pgcN}`]?.cells[String(this.state.cellN)] ?? null;
  }

  /** The cell finished playing (and its still time is over): run its cell command or go on. */
  cellEnded(): void {
    if (this.stopped) return;
    this.process(this.playCellPost());
  }

  select(button: number): void {
    this.sprm[8] = button << 10;
  }

  /** Run a menu button's command (dvdnav_button_activate -> vm_exec_cmd). */
  activate(button: ButtonJson): void {
    this.select(button.n);
    this.log(`button ${button.n}: ${button.txt}`);
    const r = this.evalCmds([button.cmd], [button.txt]);
    if (r) this.process(r);
  }

  /** The remote's menu keys (vm_jump_menu). */
  menuCall(menu: "title" | "root" | "subpicture" | "audio" | "angle" | "chapter"): boolean {
    const old = this.state.domain;
    if (old === "FP") return false;
    if (old === "VTS") this.setRSMinfo(0);
    this.state.domain = menu === "title" ? "VMGM" : "VTSM";
    if (this.setMenu(MENU_ID[menu])) {
      this.log(`menu key: ${menu}`);
      this.process(this.playPGC());
      return true;
    }
    this.state.domain = old;
    return false;
  }

  // ------------------------------------------------------------------ PGC tables

  private pgcit(domain: Domain = this.state.domain): PgcJson[] | null {
    const lang = this.pack.menu_lang;
    const pick = (m: Record<string, PgcJson[]>) => m[lang] ?? Object.values(m)[0] ?? null;
    if (domain === "VTS") return this.pack.vts[String(this.state.vtsN)]?.title_pgcs ?? null;
    if (domain === "VTSM") return this.pack.vts[String(this.state.vtsN)] ? pick(this.pack.vts[String(this.state.vtsN)].menus) : null;
    return pick(this.pack.vmg.menus);
  }

  private setPGCN(pgcN: number): boolean {
    const t = this.pgcit();
    if (!t || pgcN < 1 || pgcN > t.length) return false;
    this.state.pgc = t[pgcN - 1];
    this.state.pgcN = pgcN;
    this.state.pgN = 1;
    if (this.state.domain === "VTS") this.sprm[6] = pgcN;
    return true;
  }

  private setMenu(id: number): boolean {
    const t = this.pgcit();
    if (!t) return false;
    const i = t.findIndex((p) => p.entry !== null && MENU_ID[p.entry] === id);
    return i >= 0 && this.setPGCN(i + 1);
  }

  private getTT(vtsN: number, ttn: number): number {
    return this.pack.vmg.titles.findIndex((t) => t.vts === vtsN && t.ttn === ttn) + 1;
  }

  private setVTS_PTT(vtsN: number, ttn: number, part: number): boolean {
    this.state.domain = "VTS";
    this.state.vtsN = vtsN;
    const v = this.pack.vts[String(vtsN)];
    if (!v || ttn < 1 || ttn > v.ptt.length || part < 1 || part > v.ptt[ttn - 1].length) return false;
    const [pgcN, pgN] = v.ptt[ttn - 1][part - 1];
    this.sprm[6] = pgcN;
    this.sprm[7] = part;
    this.sprm[4] = this.getTT(vtsN, ttn);
    if (this.sprm[4] === 0) return false;
    this.sprm[5] = ttn;
    const ok = this.setPGCN(pgcN);
    this.state.pgN = pgN;
    return ok;
  }

  private setTT(tt: number): boolean {
    const t = this.pack.vmg.titles[tt - 1];
    return !!t && this.setVTS_PTT(t.vts, t.ttn, 1);
  }

  private setPGN(): boolean {
    const p = this.state.pgc;
    let n = 0;
    while (n < p.program_map.length && this.state.cellN >= p.program_map[n]) n++;
    if (n === p.program_map.length && this.state.cellN > p.cells.length) return false;
    this.state.pgN = n;
    if (this.state.domain === "VTS") {
      const ptts = this.pack.vts[String(this.state.vtsN)]?.ptt[this.sprm[5] - 1] ?? [];
      let part = 0;
      ptts.forEach(([pgcn, pgn], i) => {
        if (pgcn === this.state.pgcN && pgn <= this.state.pgN) part = i + 1;
      });
      if (part) this.sprm[7] = part;
    }
    return true;
  }

  private setRSMinfo(cellN: number): void {
    this.rsm = {
      vtsN: this.state.vtsN,
      pgcN: this.state.pgcN,
      cellN: cellN || this.state.cellN,
      regs: Array.from(this.sprm.slice(4, 9)),
    };
  }

  // ------------------------------------------------------------------ play state machine (vm.c)

  private playPGC(): Link {
    this.state.pgN = 1;
    this.state.cellN = 0;
    this.log(`PGC ${this.where()}${this.state.pgc.entry ? ` (${this.state.pgc.entry} menu)` : ""}`);
    const r = this.evalCmds(this.state.pgc.pre, this.state.pgc.txt.pre);
    return r ?? this.playPG();
  }

  private playPGC_PG(pgN: number): Link {
    this.state.pgN = pgN;
    this.state.cellN = 0;
    this.log(`PGC ${this.where()} from program ${pgN}`);
    const r = this.evalCmds(this.state.pgc.pre, this.state.pgc.txt.pre);
    return r ?? this.playPG();
  }

  private playPGCPost(): Link {
    const r = this.evalCmds(this.state.pgc.post, this.state.pgc.txt.post);
    if (r) return r;
    if (!this.setPGCN(this.state.pgc.next)) return link("Exit");
    return this.playPGC();
  }

  private playPG(): Link {
    const p = this.state.pgc;
    if (this.state.pgN > p.program_map.length) return this.playPGCPost();
    this.state.cellN = p.program_map[this.state.pgN - 1];
    return this.playCell();
  }

  private playCell(): Link {
    if (this.state.cellN > this.state.pgc.cells.length || this.state.cellN < 1) return this.playPGCPost();
    if (!this.setPGN()) return this.playPGCPost();
    return link("PlayThis");
  }

  private playCellPost(): Link {
    const cell = this.state.pgc.cells[this.state.cellN - 1];
    if (cell && cell.cmd) {
      const i = cell.cmd - 1;
      if (i < this.state.pgc.cellcmds.length) {
        const r = this.evalCmds([this.state.pgc.cellcmds[i]], [this.state.pgc.txt.cellcmds[i]]);
        if (r) return r;
      }
    }
    this.state.cellN++;
    if (!this.setPGN()) return this.playPGCPost();
    return this.playCell();
  }

  private process(l: Link): void {
    let guard = 0;
    while (l.cmd !== "PlayThis") {
      if (++guard > 5000) {
        this.log("process: too many links without a cell to play; stopping");
        this.stopped = true;
        return;
      }
      const s = this.state;
      switch (l.cmd) {
        case "LinkNoLink":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          return;
        case "LinkTopC":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          l = this.playCell();
          break;
        case "LinkNextC":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          s.cellN++;
          l = this.playCell();
          break;
        case "LinkPrevC":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          s.cellN--;
          l = this.playCell();
          break;
        case "LinkTopPG":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          l = this.playPG();
          break;
        case "LinkNextPG":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          s.pgN++;
          l = this.playPG();
          break;
        case "LinkPrevPG":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          s.pgN--;
          l = this.playPG();
          break;
        case "LinkTopPGC":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          l = this.playPGC();
          break;
        case "LinkNextPGC":
        case "LinkPrevPGC":
        case "LinkGoUpPGC": {
          if (l.d1) this.sprm[8] = l.d1 << 10;
          const n = l.cmd === "LinkNextPGC" ? s.pgc.next : l.cmd === "LinkPrevPGC" ? s.pgc.prev : s.pgc.goup;
          l = n && this.setPGCN(n) ? this.playPGC() : link("Exit");
          break;
        }
        case "LinkTailPGC":
          if (l.d1) this.sprm[8] = l.d1 << 10;
          l = this.playPGCPost();
          break;
        case "LinkRSM": {
          if (!this.rsm) {
            this.log("resume without resume info");
            l = link("Exit");
            break;
          }
          s.domain = "VTS";
          s.vtsN = this.rsm.vtsN;
          this.setPGCN(this.rsm.pgcN);
          this.rsm.regs.forEach((v, i) => (this.sprm[4 + i] = v));
          if (l.d1) this.sprm[8] = l.d1 << 10;
          this.log(`resume: ${this.where()} cell ${this.rsm.cellN}`);
          if (this.rsm.cellN === 0) {
            s.pgN = 1;
            l = this.playPG();
          } else {
            s.cellN = this.rsm.cellN;
            l = this.setPGN() ? link("PlayThis") : link("LinkTailPGC");
          }
          break;
        }
        case "LinkPGCN":
          l = this.setPGCN(l.d1) ? this.playPGC() : link("Exit");
          break;
        case "LinkPTTN":
          if (l.d2) this.sprm[8] = l.d2 << 10;
          l = this.setVTS_PTT(s.vtsN, this.sprm[5], l.d1) ? this.playPG() : link("Exit");
          break;
        case "LinkPGN":
          if (l.d2) this.sprm[8] = l.d2 << 10;
          s.pgN = l.d1;
          l = this.playPG();
          break;
        case "LinkCN":
          if (l.d2) this.sprm[8] = l.d2 << 10;
          s.cellN = l.d1;
          l = this.playCell();
          break;
        case "Exit":
          this.log("exit: playback stopped");
          this.stopped = true;
          return;
        case "JumpTT":
          l = this.setTT(l.d1) ? this.playPGC() : link("Exit");
          break;
        case "JumpVTS_TT":
          l = this.setVTS_PTT(s.vtsN, l.d1, 1) ? this.playPGC() : link("Exit");
          break;
        case "JumpVTS_PTT":
          l = this.setVTS_PTT(s.vtsN, l.d1, l.d2) ? this.playPGC_PG(s.pgN) : link("Exit");
          break;
        case "JumpSS_FP":
          s.domain = "FP";
          s.pgc = this.pack.vmg.fp;
          s.pgcN = 0;
          l = this.playPGC();
          break;
        case "JumpSS_VMGM_MENU":
          s.domain = "VMGM";
          l = this.setMenu(l.d1) ? this.playPGC() : link("Exit");
          break;
        case "JumpSS_VTSM":
          if (l.d1) {
            s.vtsN = l.d1;
            s.domain = "VTSM";
            this.sprm[5] = l.d2;
            this.sprm[4] = this.getTT(s.vtsN, l.d2);
          }
          l = this.setMenu(l.d3) ? this.playPGC() : link("Exit");
          break;
        case "JumpSS_VMGM_PGC":
          s.domain = "VMGM";
          l = this.setPGCN(l.d1) ? this.playPGC() : link("Exit");
          break;
        case "CallSS_FP":
          this.setRSMinfo(l.d1);
          s.domain = "FP";
          s.pgc = this.pack.vmg.fp;
          s.pgcN = 0;
          l = this.playPGC();
          break;
        case "CallSS_VMGM_MENU":
          this.setRSMinfo(l.d2);
          s.domain = "VMGM";
          l = this.setMenu(l.d1) ? this.playPGC() : link("Exit");
          break;
        case "CallSS_VTSM":
          this.setRSMinfo(l.d2);
          s.domain = "VTSM";
          l = this.setMenu(l.d1) ? this.playPGC() : link("Exit");
          break;
        case "CallSS_VMGM_PGC":
          this.setRSMinfo(l.d2);
          s.domain = "VMGM";
          l = this.setPGCN(l.d1) ? this.playPGC() : link("Exit");
          break;
      }
    }
    this.log(`play ${this.where()} cell ${this.state.cellN}`);
  }

  where(): string {
    const s = this.state;
    if (s.domain === "FP") return "FP";
    if (s.domain === "VMGM") return `VMGM pgc ${s.pgcN}`;
    if (s.domain === "VTSM") return `VTSM${s.vtsN} pgc ${s.pgcN}`;
    return `VTS${s.vtsN} pgc ${s.pgcN} (title ${this.sprm[4]}, chapter ${this.sprm[7]})`;
  }

  // ------------------------------------------------------------------ command evaluation (decoder.c)

  /** Run a command list; a Link result means "jump", null means it fell through (or hit Break). */
  private evalCmds(cmds: string[], txt: string[]): Link | null {
    let i = 0;
    let total = 0;
    while (i < cmds.length && total < 100000) {
      if (++this.steps % 100000 === 0) this.log(`(${this.steps} commands run)`);
      const out: { link: Link | null } = { link: null };
      const line = this.evalCmd(command(cmds[i]), out);
      if (line < 0) {
        this.log(`  ${txt[i] ?? cmds[i]}  -> ${out.link!.cmd}${out.link!.d1 ? " " + out.link!.d1 : ""}`);
        return out.link;
      }
      i = line > 0 ? line - 1 : i + 1;
      total++;
    }
    return null;
  }

  private getG(r: number): number {
    return this.gprm[r & 15];
  }

  private setG(r: number, v: number): void {
    this.gprm[r & 15] = v & 0xffff;
  }

  private reg(r: number): number {
    if (r & 0x80) return this.sprm[r & 0x1f] ?? 0;
    return this.getG(r & 0x0f);
  }

  private regOrData(c: Command, imm: number, start: number): number {
    return imm ? c.bits(start, 16) : this.reg(c.bits(start - 8, 8));
  }

  private regOrData2(c: Command, imm: number, start: number): number {
    return imm ? c.bits(start - 1, 7) : this.getG(c.bits(start - 4, 4));
  }

  private compare(op: number, a: number, b: number): boolean {
    switch (op) {
      case 1: return (a & b) !== 0;
      case 2: return a === b;
      case 3: return a !== b;
      case 4: return a >= b;
      case 5: return a > b;
      case 6: return a <= b;
      case 7: return a < b;
    }
    return false;
  }

  private if1(c: Command): boolean {
    const op = c.bits(54, 3);
    return op ? this.compare(op, this.reg(c.bits(39, 8)), this.regOrData(c, c.bits(55, 1), 31)) : true;
  }
  private if2(c: Command): boolean {
    const op = c.bits(54, 3);
    return op ? this.compare(op, this.reg(c.bits(15, 8)), this.reg(c.bits(7, 8))) : true;
  }
  private if3(c: Command): boolean {
    const op = c.bits(54, 3);
    return op ? this.compare(op, this.reg(c.bits(43, 4)), this.regOrData(c, c.bits(55, 1), 15)) : true;
  }
  private if4(c: Command): boolean {
    const op = c.bits(54, 3);
    return op ? this.compare(op, this.reg(c.bits(51, 4)), this.regOrData(c, c.bits(55, 1), 31)) : true;
  }
  private if5(c: Command): boolean {
    const op = c.bits(54, 3);
    if (!op) return true;
    if (c.bits(60, 1)) return this.compare(op, this.reg(c.bits(31, 8)), this.reg(c.bits(23, 8)));
    return this.compare(op, this.reg(c.bits(39, 8)), this.reg(c.bits(31, 8)));
  }

  private setOp(op: number, r: number, r2: number, data: number): void {
    const cur = this.getG(r);
    switch (op) {
      case 1: this.setG(r, data); break;
      case 2: this.setG(r2, this.gprm[r]); this.setG(r, data); break;
      case 3: this.setG(r, Math.min(cur + data, 0xffff)); break;
      case 4: this.setG(r, Math.max(cur - data, 0)); break;
      case 5: this.setG(r, Math.min(cur * data, 0xffff)); break;
      case 6: this.setG(r, data ? Math.floor(cur / data) : 0xffff); break;
      case 7: this.setG(r, data ? cur % data : 0xffff); break;
      case 8: this.setG(r, 1 + Math.floor(data * this.rnd())); break;
      case 9: this.setG(r, cur & data); break;
      case 10: this.setG(r, cur | data); break;
      case 11: this.setG(r, cur ^ data); break;
    }
  }

  private set1(c: Command, cond: boolean): void {
    const data = this.regOrData(c, c.bits(60, 1), 31);
    if (cond) this.setOp(c.bits(59, 4), c.bits(35, 4), c.bits(19, 4), data);
  }
  private set2(c: Command, cond: boolean): void {
    const data = this.regOrData(c, c.bits(60, 1), 47);
    if (cond) this.setOp(c.bits(59, 4), c.bits(51, 4), c.bits(35, 4), data);
  }

  private linkSubins(c: Command, cond: boolean, out: { link: Link | null }): boolean {
    const op = c.bits(4, 5);
    const cmd = SUBINS[op];
    if (!cmd) return false;
    out.link = link(cmd, c.bits(15, 6));
    return cond;
  }

  private linkIns(c: Command, cond: boolean, out: { link: Link | null }): boolean {
    switch (c.bits(51, 4)) {
      case 1: return this.linkSubins(c, cond, out);
      case 4: out.link = link("LinkPGCN", c.bits(14, 15)); return cond;
      case 5: out.link = link("LinkPTTN", c.bits(9, 10), c.bits(15, 6)); return cond;
      case 6: out.link = link("LinkPGN", c.bits(6, 7), c.bits(15, 6)); return cond;
      case 7: out.link = link("LinkCN", c.bits(7, 8), c.bits(15, 6)); return cond;
    }
    return false;
  }

  private jumpIns(c: Command, cond: boolean, out: { link: Link | null }): boolean {
    switch (c.bits(51, 4)) {
      case 1: out.link = link("Exit"); return cond;
      case 2: out.link = link("JumpTT", c.bits(22, 7)); return cond;
      case 3: out.link = link("JumpVTS_TT", c.bits(22, 7)); return cond;
      case 5: out.link = link("JumpVTS_PTT", c.bits(22, 7), c.bits(41, 10)); return cond;
      case 6:
        switch (c.bits(23, 2)) {
          case 0: out.link = link("JumpSS_FP"); return cond;
          case 1: out.link = link("JumpSS_VMGM_MENU", c.bits(19, 4)); return cond;
          case 2: out.link = link("JumpSS_VTSM", c.bits(31, 8), c.bits(39, 8), c.bits(19, 4)); return cond;
          case 3: out.link = link("JumpSS_VMGM_PGC", c.bits(46, 15)); return cond;
        }
        break;
      case 8:
        switch (c.bits(23, 2)) {
          case 0: out.link = link("CallSS_FP", c.bits(31, 8)); return cond;
          case 1: out.link = link("CallSS_VMGM_MENU", c.bits(19, 4), c.bits(31, 8)); return cond;
          case 2: out.link = link("CallSS_VTSM", c.bits(19, 4), c.bits(31, 8)); return cond;
          case 3: out.link = link("CallSS_VMGM_PGC", c.bits(46, 15), c.bits(31, 8)); return cond;
        }
        break;
    }
    return false;
  }

  private systemSet(c: Command, cond: boolean, out: { link: Link | null }): boolean {
    switch (c.bits(59, 4)) {
      case 1:
        for (let i = 1; i <= 3; i++) {
          if (c.bits(63 - (2 + i) * 8, 1)) {
            const d = this.regOrData2(c, c.bits(60, 1), 47 - i * 8);
            if (cond) this.sprm[i] = d;
          }
        }
        break;
      case 2: {
        const d = this.regOrData(c, c.bits(60, 1), 47);
        const d2 = c.bits(15, 16);
        if (cond) {
          this.sprm[9] = d;
          this.sprm[10] = d2;
          this.log(`  (navigation timer set to ${d} s; the player does not run it)`);
        }
        break;
      }
      case 3: {
        const d = this.regOrData(c, c.bits(60, 1), 47);
        const r = c.bits(19, 4);
        this.gprmCounter[r] = c.bits(23, 1);
        if (cond) this.setG(r, d);
        break;
      }
      case 6: {
        const d = this.regOrData(c, c.bits(60, 1), 31);
        if (cond) this.sprm[8] = d;
        break;
      }
    }
    return c.bits(51, 4) ? this.linkIns(c, cond, out) : false;
  }

  private special(c: Command, cond: boolean): number {
    switch (c.bits(51, 4)) {
      case 0: return 0;
      case 1: return cond ? c.bits(7, 8) : 0;
      case 2: return cond ? 256 : 0;
      case 3:
        if (cond) this.sprm[13] = c.bits(11, 4);
        return cond ? c.bits(7, 8) : 0;
    }
    return 0;
  }

  /** Returns -1 for a link (in out.link), >0 for a goto line, 0 to go on. */
  private evalCmd(c: Command, out: { link: Link | null }): number {
    let cond: boolean;
    switch (c.bits(63, 3)) {
      case 0:
        cond = this.if1(c);
        return this.special(c, cond);
      case 1:
        if (c.bits(60, 1)) {
          cond = this.if2(c);
          return this.jumpIns(c, cond, out) ? -1 : 0;
        }
        cond = this.if1(c);
        return this.linkIns(c, cond, out) ? -1 : 0;
      case 2:
        cond = this.if2(c);
        return this.systemSet(c, cond, out) ? -1 : 0;
      case 3:
        cond = this.if3(c);
        this.set1(c, cond);
        return c.bits(51, 4) && this.linkIns(c, cond, out) ? -1 : 0;
      case 4:
        this.set2(c, true);
        cond = this.if4(c);
        return this.linkSubins(c, cond, out) ? -1 : 0;
      case 5:
        cond = this.if5(c);
        this.set2(c, cond);
        return this.linkSubins(c, cond, out) ? -1 : 0;
      case 6:
        cond = this.if5(c);
        this.set2(c, cond);
        return this.linkSubins(c, true, out) ? -1 : 0;
    }
    return 0;
  }
}
