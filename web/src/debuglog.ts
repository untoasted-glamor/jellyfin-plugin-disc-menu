// The Disc menu's log: what the page shows (with a level), the VM's trace, and, after a hand-off, what the web client
// made of it. No DOM, so the tests and the button script (inject.ts) import it directly.
//
// It lives in the tab's sessionStorage, which the overlay's frame shares with the web client (same origin, same tab).
// So the button script can add the outcome of a hand-off after the overlay is gone, and the next Disc menu open in the
// tab shows it, with the earlier opens marked. Anything in the stored log is checked entry by entry on reading: the
// web client's other scripts could write there too, and the panel shows it as text only.

/** A level the panel filters and counts on. */
export type Level = "info" | "warn" | "error";

export interface LogEntry {
  /** Clock time, ms since the epoch. */
  t: number;
  /** Which open of the Disc menu in this tab (see Run). */
  run: number;
  level: Level;
  text: string;
}

export interface TraceLine {
  t: number;
  run: number;
  text: string;
}

/** One open of the Disc menu: when it opened and when its disc started (for "seconds since Start disc"). */
export interface Run {
  id: number;
  opened: number;
  started: number | null;
}

export interface LogData {
  runs: Run[];
  events: LogEntry[];
  trace: TraceLine[];
  /** Warnings and errors up to this time were seen in the open panel. */
  seen: number;
}

/** The parts of a Storage the log uses, so tests can pass a fake. */
export interface LogStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LOG_KEY = "discmenu.log";
/** Entries kept, and trace lines kept, across the opens in the log. */
export const MAX_ENTRIES = 1000;
const MAX_RUNS = 50;
const TEXT_MAX = 2000;
const LEVELS = new Set<Level>(["info", "warn", "error"]);

const empty = (): LogData => ({ runs: [], events: [], trace: [], seen: 0 });

/** The tab's sessionStorage, or null where the browser refuses it (some private modes, sandboxed frames). */
export function tabStore(win: Window): LogStore | null {
  try {
    const s = win.sessionStorage;
    s.getItem(LOG_KEY);
    return s;
  } catch {
    return null;
  }
}

const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isText = (v: unknown): v is string => typeof v === "string";
const clip = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}...` : s);

/** The stored log, keeping only well-formed parts; an empty log for anything unreadable. */
export function readLog(store: LogStore | null): LogData {
  let raw: unknown;
  try {
    raw = JSON.parse(store?.getItem(LOG_KEY) ?? "null");
  } catch {
    return empty();
  }
  if (!raw || typeof raw !== "object") return empty();
  const d = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, unknown>[];
  const runs = list(d.runs)
    .filter((r) => r && isTime(r.id) && isTime(r.opened) && (r.started === null || isTime(r.started)))
    .map((r) => ({ id: r.id as number, opened: r.opened as number, started: r.started as number | null }));
  const events = list(d.events)
    .filter((e) => e && isTime(e.t) && isTime(e.run) && LEVELS.has(e.level as Level) && isText(e.text))
    .map((e) => ({ t: e.t as number, run: e.run as number, level: e.level as Level, text: clip(e.text as string) }));
  const trace = list(d.trace)
    .filter((e) => e && isTime(e.t) && isTime(e.run) && isText(e.text))
    .map((e) => ({ t: e.t as number, run: e.run as number, text: clip(e.text as string) }));
  return {
    runs: runs.slice(-MAX_RUNS),
    events: events.slice(-MAX_ENTRIES),
    trace: trace.slice(-MAX_ENTRIES),
    seen: isTime(d.seen) ? d.seen : 0,
  };
}

/** Writes the log; when the storage is full, drops the older half and tries once more. Never throws. */
export function writeLog(store: LogStore | null, data: LogData): void {
  if (!store) return;
  try {
    store.setItem(LOG_KEY, JSON.stringify(data));
  } catch {
    try {
      const half = (n: number) => Math.floor(n / 2);
      store.setItem(LOG_KEY, JSON.stringify({
        ...data,
        events: data.events.slice(half(data.events.length)),
        trace: data.trace.slice(half(data.trace.length)),
      }));
    } catch {
      /* the log stays in the page only */
    }
  }
}

/** Adds one entry to the last open in the stored log (the button script, after a hand-off). */
export function appendEvent(store: LogStore | null, level: Level, text: string, now = Date.now()): void {
  if (!store) return;
  const data = readLog(store);
  const run = data.runs.at(-1)?.id ?? 0;
  data.events.push({ t: now, run, level, text: clip(text) });
  data.events = data.events.slice(-MAX_ENTRIES);
  writeLog(store, data);
}

/** The page's side of the log: a new open, its entries and trace, written back soon after each change. */
export class DebugLog {
  readonly data: LogData;
  readonly run: number;
  private listeners: ((e: LogEntry | null) => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: LogStore | null,
    private readonly now: () => number = Date.now,
    private readonly writeMs = 500,
  ) {
    this.data = readLog(store);
    this.run = (this.data.runs.at(-1)?.id ?? 0) + 1;
    this.data.runs.push({ id: this.run, opened: now(), started: null });
    this.data.runs = this.data.runs.slice(-MAX_RUNS);
    this.save();
  }

  /** The disc started (or restarted): "seconds since Start disc" count from here. */
  started(): void {
    const r = this.data.runs.find((x) => x.id === this.run);
    if (r) r.started = this.now();
    this.save();
  }

  add(level: Level, text: string): LogEntry {
    const e: LogEntry = { t: this.now(), run: this.run, level, text: clip(text) };
    this.data.events.push(e);
    if (this.data.events.length > MAX_ENTRIES) this.data.events.splice(0, this.data.events.length - MAX_ENTRIES);
    this.save();
    this.listeners.forEach((l) => l(e));
    return e;
  }

  trace(text: string): void {
    this.data.trace.push({ t: this.now(), run: this.run, text: clip(text) });
    if (this.data.trace.length > MAX_ENTRIES) this.data.trace.splice(0, this.data.trace.length - MAX_ENTRIES);
    this.save();
    this.listeners.forEach((l) => l(null));
  }

  /** Called with each new entry, and with null for a trace line. */
  onChange(l: (e: LogEntry | null) => void): void {
    this.listeners.push(l);
  }

  counts(): { warn: number; error: number } {
    let warn = 0;
    let error = 0;
    for (const e of this.data.events) {
      if (e.level === "warn") warn++;
      else if (e.level === "error") error++;
    }
    return { warn, error };
  }

  /** Whether a warning or error came after the panel was last open. */
  get unseen(): boolean {
    return this.data.events.some((e) => e.level !== "info" && e.t > this.data.seen);
  }

  markSeen(): void {
    this.data.seen = Math.max(this.data.seen, this.data.events.at(-1)?.t ?? 0, this.now());
    this.save();
  }

  /** When an open's disc started, for an entry's "seconds since Start disc". */
  startOf(run: number): number | null {
    return this.data.runs.find((r) => r.id === run)?.started ?? null;
  }

  /** Writes now (before the page goes, and before a hand-off, so the button script adds to the latest log). */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    writeLog(this.store, this.data);
  }

  private save(): void {
    if (!this.store || this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.writeMs);
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "14:03:07.250", local time. */
export function clock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** "+12.3 s" since its open's Start disc, or "" before the disc started. */
export function since(t: number, start: number | null): string {
  return start === null || t < start ? "" : `+${((t - start) / 1000).toFixed(1)} s`;
}

const LABEL: Record<Level, string> = { info: "INFO", warn: "WARN", error: "ERROR" };

/** One entry as a line of text (for Copy). */
export function entryLine(e: LogEntry, start: number | null, current: number): string {
  const earlier = e.run === current ? "" : ` [open ${e.run}]`;
  return `${clock(e.t)} ${since(e.t, start).padEnd(9)} ${LABEL[e.level].padEnd(5)} ${e.text}${earlier}`;
}

/** The whole log as plain text, the live state at the top, for pasting into a bug report or a chat. */
export function logText(log: DebugLog, state: string[], now = Date.now()): string {
  const { warn, error } = log.counts();
  const lines = [
    `Disc menu stats, copied ${new Date(now).toISOString()}`,
    "",
    ...state,
    "",
    `Log: ${log.data.events.length} entries, ${warn} warnings, ${error} errors (this is open ${log.run})`,
    ...log.data.events.map((e) => entryLine(e, log.startOf(e.run), log.run)),
    "",
    `VM trace: ${log.data.trace.length} lines`,
    ...log.data.trace.map((l) => `${clock(l.t)} ${since(l.t, log.startOf(l.run)).padEnd(9)} ${l.text}${l.run === log.run ? "" : ` [open ${l.run}]`}`),
  ];
  return lines.join("\n");
}
