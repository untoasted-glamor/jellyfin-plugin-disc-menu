// The Stats panel ("stats for nerds") over the menu: the live state at the top, then the log (debuglog.ts) with a
// filter, a Copy button, and in the overlay the "Wait before playing from menu" switch. Off by default; whether it is
// open is remembered per browser. The menu keeps its keys and taps around it: keys go to the panel only while the
// focus is on one of its buttons.
//
// Log entries hold pack and server data (disc names, file names), so every element is built with createElement and
// textContent (test/safety.test.ts).
import { clock, DebugLog, LogEntry, logText, MAX_ENTRIES, since, TraceLine } from "./debuglog.js";

export type Filter = "all" | "problems" | "trace";

/** localStorage, or a fake: only the open state is kept there. */
export interface Prefs {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StatsOptions {
  /** In the Disc menu button's overlay (the wait switch shows only there). */
  embedded: boolean;
  /** The live state, one line each. */
  state: () => string[];
  prefs: Prefs;
  /** The buttons that open the panel: they get a dot while a warning or error is unseen. */
  toggles: HTMLButtonElement[];
  onWait?: (on: boolean) => void;
  clipboard?: (text: string) => Promise<void>;
}

export const OPEN_KEY = "discmenu.stats";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["problems", "Warnings and errors"],
  ["trace", "VM trace"],
];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export class StatsPanel {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly stateEl: HTMLPreElement;
  private readonly listEl: HTMLOListElement;
  private readonly noteEl: HTMLParagraphElement;
  private readonly copyArea: HTMLTextAreaElement;
  private readonly filterButtons = new Map<Filter, HTMLButtonElement>();
  private readonly waitButton: HTMLButtonElement | null = null;
  private filter: Filter = "all";
  private waiting = false;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly doc: Document,
    host: HTMLElement,
    private readonly log: DebugLog,
    private readonly opts: StatsOptions,
  ) {
    const el = (this.el = doc.createElement("aside"));
    el.id = "stats";
    el.className = "stats";
    el.hidden = true;
    el.setAttribute("aria-label", "Stats");

    const head = doc.createElement("div");
    head.className = "stats-head";
    this.titleEl = doc.createElement("h2");
    this.titleEl.className = "stats-title";
    head.append(this.titleEl, this.button("Copy", "stats-copy-btn", () => void this.copy()), this.button("Close", "stats-close", () => this.close()));

    const tools = doc.createElement("div");
    tools.className = "stats-tools";
    for (const [f, label] of FILTERS) {
      const b = this.button(label, `stats-f-${f}`, () => this.setFilter(f));
      this.filterButtons.set(f, b);
      tools.append(b);
    }
    if (opts.embedded) {
      const w = (this.waitButton = this.button("", "stats-wait", () => this.setWait(!this.waiting)));
      w.setAttribute("role", "switch");
      tools.append(w);
    }

    this.stateEl = doc.createElement("pre");
    this.stateEl.className = "stats-state";
    this.noteEl = doc.createElement("p");
    this.noteEl.className = "stats-note";
    this.copyArea = doc.createElement("textarea");
    this.copyArea.className = "stats-copy";
    this.copyArea.readOnly = true;
    this.copyArea.hidden = true;
    this.copyArea.setAttribute("aria-label", "The log as text");
    this.listEl = doc.createElement("ol");
    this.listEl.className = "stats-log";

    el.append(head, tools, this.stateEl, this.noteEl, this.copyArea, this.listEl);
    host.append(el);

    log.onChange((e) => this.added(e));
    this.setFilter("all");
    this.setWait(false, false);
    this.counts();
  }

  /** Opens the panel when it was open last time in this browser (once the page can give its live state). */
  restore(): void {
    let remembered = false;
    try {
      remembered = this.opts.prefs.getItem(OPEN_KEY) === "1";
    } catch {
      /* not remembered */
    }
    if (remembered) this.open();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Whether a held hand-off waits ("Wait before playing from menu"); off on every open of the Disc menu. */
  get wait(): boolean {
    return this.waiting;
  }

  /** `focus` puts the focus on the panel (opened from a button, with a remote). */
  open(focus = false): void {
    this.el.hidden = false;
    this.remember(true);
    this.renderList();
    this.refresh();
    this.log.markSeen();
    this.counts();
    this.ticker ??= setInterval(() => this.refresh(), 1000);
    if (focus) this.filterButtons.get(this.filter)?.focus();
  }

  close(): void {
    const had = this.el.contains(this.doc.activeElement);
    this.el.hidden = true;
    this.remember(false);
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    this.copyArea.hidden = true;
    if (had) (this.doc.activeElement as HTMLElement).blur();
    this.counts();
  }

  toggle(focus = false): void {
    if (this.isOpen) this.close();
    else this.open(focus);
  }

  /** Redraws the live state (the player calls it as the VM moves; once a second while open). */
  refresh(): void {
    if (!this.isOpen) return;
    this.stateEl.textContent = this.opts.state().join("\n");
  }

  /**
   * A key while the focus is in the panel. Left and Right move along its buttons, Up and Down scroll the log, Back
   * gives the focus back to the menu (the panel stays open). Returns whether the key was the panel's; Enter is left to
   * the focused button.
   */
  key(e: KeyboardEvent, isBack: boolean): boolean {
    const buttons = [...this.el.querySelectorAll<HTMLButtonElement>("button")];
    const at = buttons.indexOf(this.doc.activeElement as HTMLButtonElement);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      buttons[(at + (e.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      this.listEl.scrollTop += e.key === "ArrowUp" ? -60 : 60;
    } else if (isBack) {
      (this.doc.activeElement as HTMLElement | null)?.blur();
    } else return false;
    e.preventDefault();
    return true;
  }

  /** Puts the whole log on the clipboard, or, where the browser refuses, selects it in a text area to copy by hand. */
  async copy(): Promise<"clipboard" | "manual"> {
    const text = logText(this.log, this.opts.state());
    const lines = text.split("\n").length;
    try {
      const write = this.opts.clipboard ?? ((t: string) => this.doc.defaultView!.navigator.clipboard.writeText(t));
      await write(text);
      this.copyArea.hidden = true;
      this.noteEl.textContent = `Copied ${plural(lines, "line")}.`;
      return "clipboard";
    } catch {
      this.copyArea.value = text;
      this.copyArea.hidden = false;
      this.copyArea.focus();
      this.copyArea.select();
      this.noteEl.textContent = "The browser didn't allow the clipboard here: the log is selected below, copy it by hand.";
      return "manual";
    }
  }

  private button(label: string, id: string, click: () => void): HTMLButtonElement {
    const b = this.doc.createElement("button");
    b.type = "button";
    b.id = id;
    b.textContent = label;
    b.addEventListener("click", click);
    return b;
  }

  private remember(open: boolean): void {
    try {
      this.opts.prefs.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* not remembered */
    }
  }

  private setFilter(f: Filter): void {
    this.filter = f;
    for (const [k, b] of this.filterButtons) b.setAttribute("aria-pressed", String(k === f));
    this.renderList();
  }

  private setWait(on: boolean, notify = true): void {
    this.waiting = on;
    if (!this.waitButton) return;
    this.waitButton.textContent = `Wait before playing from menu: ${on ? "On" : "Off"}`;
    this.waitButton.setAttribute("aria-checked", String(on));
    if (notify) this.opts.onWait?.(on);
  }

  private shows(e: LogEntry): boolean {
    return this.filter === "all" || (this.filter === "problems" && e.level !== "info");
  }

  private entryItem(e: LogEntry): HTMLLIElement {
    const li = this.doc.createElement("li");
    li.className = `lvl-${e.level}${e.run === this.log.run ? "" : " earlier"}`;
    const when = this.doc.createElement("span");
    when.className = "when";
    const at = since(e.t, this.log.startOf(e.run));
    when.textContent = `${clock(e.t)}${at ? ` ${at}` : ""}${e.run === this.log.run ? "" : ` (open ${e.run})`}`;
    const lvl = this.doc.createElement("span");
    lvl.className = "lvl";
    lvl.textContent = e.level === "info" ? "info" : e.level === "warn" ? "warning" : "error";
    const text = this.doc.createElement("span");
    text.className = "text";
    text.textContent = e.text;
    li.append(when, lvl, text);
    return li;
  }

  private traceItem(l: TraceLine): HTMLLIElement {
    const li = this.doc.createElement("li");
    li.className = `lvl-trace${l.run === this.log.run ? "" : " earlier"}`;
    const when = this.doc.createElement("span");
    when.className = "when";
    const at = since(l.t, this.log.startOf(l.run));
    when.textContent = `${clock(l.t)}${at ? ` ${at}` : ""}${l.run === this.log.run ? "" : ` (open ${l.run})`}`;
    const text = this.doc.createElement("span");
    text.className = "text";
    text.textContent = l.text;
    li.append(when, text);
    return li;
  }

  private renderList(): void {
    if (!this.isOpen) return;
    const items =
      this.filter === "trace" ? this.log.data.trace.map((l) => this.traceItem(l)) : this.log.data.events.filter((e) => this.shows(e)).map((e) => this.entryItem(e));
    this.listEl.replaceChildren(...items);
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  /** A new entry (null: a trace line): appended in place when it shows, and counted. */
  private added(e: LogEntry | null): void {
    if (this.isOpen) {
      const atEnd = this.listEl.scrollTop + this.listEl.clientHeight >= this.listEl.scrollHeight - 8;
      if (e && this.shows(e) && this.filter !== "trace") this.listEl.append(this.entryItem(e));
      else if (!e && this.filter === "trace") this.listEl.append(this.traceItem(this.log.data.trace.at(-1)!));
      while (this.listEl.childElementCount > MAX_ENTRIES) this.listEl.firstElementChild!.remove();
      if (atEnd) this.listEl.scrollTop = this.listEl.scrollHeight;
      if (e && e.level !== "info") this.log.markSeen();
    }
    if (e) this.counts();
  }

  /** The title's counts, and the dot on the buttons that open the panel. */
  private counts(): void {
    const { warn, error } = this.log.counts();
    this.titleEl.textContent = `Stats: ${plural(warn, "warning")}, ${plural(error, "error")}`;
    const dot = !this.isOpen && this.log.unseen;
    for (const b of this.opts.toggles) {
      b.classList.toggle("dot", dot);
      b.setAttribute("aria-expanded", String(this.isOpen));
      b.setAttribute("aria-label", dot ? "Stats (new warnings or errors)" : "Stats");
    }
  }
}
