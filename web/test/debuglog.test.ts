// The Disc menu's log in the tab's sessionStorage: what is kept, what is dropped on reading, and the copied text.
import { describe, expect, it, vi } from "vitest";
import { appendEvent, clock, DebugLog, entryLine, LOG_KEY, LogStore, logText, MAX_ENTRIES, readLog, since, writeLog } from "../src/debuglog.js";

function memory(): LogStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe("the stored log", () => {
  it("reads as empty when missing, unreadable or not a log", () => {
    const s = memory();
    expect(readLog(s)).toEqual({ runs: [], events: [], trace: [], seen: 0 });
    s.setItem(LOG_KEY, "{not json");
    expect(readLog(s).events).toEqual([]);
    s.setItem(LOG_KEY, '"a string"');
    expect(readLog(s).runs).toEqual([]);
    expect(readLog(null).events).toEqual([]);
  });

  it("drops entries that aren't well formed, and keeps markup as plain text", () => {
    const s = memory();
    s.setItem(LOG_KEY, JSON.stringify({
      runs: [{ id: 1, opened: 5, started: null }, { id: "2", opened: 5, started: null }],
      events: [
        { t: 10, run: 1, level: "warn", text: "<img src=x onerror=alert(1)>" },
        { t: 11, run: 1, level: "debug", text: "unknown level" },
        { t: -1, run: 1, level: "info", text: "bad time" },
        { t: 12, run: 1, level: "info", text: 42 },
        null,
      ],
      trace: [{ t: 13, run: 1, text: "PGC VMGM pgc 1" }, { t: 13, text: "no run" }],
      seen: "soon",
    }));
    const d = readLog(s);
    expect(d.runs).toEqual([{ id: 1, opened: 5, started: null }]);
    expect(d.events).toEqual([{ t: 10, run: 1, level: "warn", text: "<img src=x onerror=alert(1)>" }]);
    expect(d.trace).toEqual([{ t: 13, run: 1, text: "PGC VMGM pgc 1" }]);
    expect(d.seen).toBe(0);
  });

  it("keeps the last 1000 entries and trace lines", () => {
    const s = memory();
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ t: i, run: 1, level: "info", text: `e${i}` }));
    s.setItem(LOG_KEY, JSON.stringify({ runs: [], events: many, trace: [], seen: 0 }));
    const d = readLog(s);
    expect(d.events.length).toBe(MAX_ENTRIES);
    expect(d.events[0].text).toBe("e5");
  });

  it("drops the older half when the storage is full, and never throws", () => {
    const writes: string[] = [];
    let full = true;
    const s: LogStore = {
      getItem: () => null,
      setItem: (_k, v) => {
        if (full) {
          full = false;
          throw new DOMException("full", "QuotaExceededError");
        }
        writes.push(v);
      },
    };
    const events = Array.from({ length: 10 }, (_, i) => ({ t: i, run: 1, level: "info" as const, text: `e${i}` }));
    writeLog(s, { runs: [], events, trace: [], seen: 0 });
    expect(JSON.parse(writes[0]).events.map((e: { text: string }) => e.text)).toEqual(["e5", "e6", "e7", "e8", "e9"]);
    const never: LogStore = { getItem: () => null, setItem: () => { throw new Error("no"); } };
    expect(() => writeLog(never, { runs: [], events, trace: [], seen: 0 })).not.toThrow();
  });

  it("the web client adds to the last open (after a hand-off)", () => {
    const s = memory();
    const log = new DebugLog(s, () => 100);
    log.flush();
    appendEvent(s, "warn", "Web client: opening the details page of S01E01 instead", 200);
    expect(readLog(s).events).toEqual([{ t: 200, run: log.run, level: "warn", text: "Web client: opening the details page of S01E01 instead" }]);
  });
});

describe("the page's log", () => {
  it("starts a new open after the earlier ones, and writes back soon after a change", () => {
    vi.useFakeTimers();
    const s = memory();
    const first = new DebugLog(s, () => 1);
    first.add("info", "one");
    vi.advanceTimersByTime(600);
    const second = new DebugLog(s, () => 2);
    expect(second.run).toBe(first.run + 1);
    expect(second.data.events.map((e) => [e.run, e.text])).toEqual([[first.run, "one"]]);
    vi.useRealTimers();
  });

  it("counts warnings and errors, and knows which came while the panel was closed", () => {
    let now = 10;
    const log = new DebugLog(memory(), () => now);
    log.add("info", "a menu");
    expect(log.unseen).toBe(false);
    now = 20;
    log.add("warn", "Title 4 chapter 1: not in the library (70.1 s), skipped");
    log.add("error", "Couldn't load the menu file m.png");
    expect(log.counts()).toEqual({ warn: 1, error: 1 });
    expect(log.unseen).toBe(true);
    log.markSeen();
    expect(log.unseen).toBe(false);
  });

  it("tells every listener about entries and trace lines", () => {
    const log = new DebugLog(null);
    const got: (string | null)[] = [];
    log.onChange((e) => got.push(e?.text ?? null));
    log.add("info", "x");
    log.trace("PGC VTSM1 pgc 9");
    expect(got).toEqual(["x", null]);
  });
});

describe("as text", () => {
  it("times an entry by the clock and since Start disc, and marks an earlier open", () => {
    const t = new Date(2026, 10, 9, 14, 3, 7, 250).getTime();
    expect(clock(t)).toBe("14:03:07.250");
    expect(since(t, t - 12_340)).toBe("+12.3 s");
    expect(since(t, null)).toBe("");
    expect(entryLine({ t, run: 2, level: "warn", text: "x" }, null, 3)).toBe("14:03:07.250           WARN  x [open 2]");
  });

  it("puts the live state first, then the entries, then the trace", () => {
    let now = 1000;
    const log = new DebugLog(null, () => now);
    log.started();
    now = 3500;
    log.add("info", "VTSM1 pgc 9: menu, 3 buttons");
    log.trace("button 1: Play");
    const text = logText(log, ["Disc: Sintel", "VM: VTSM1 pgc 9 cell 1"], 0).split("\n");
    expect(text[0]).toBe("Disc menu stats, copied 1970-01-01T00:00:00.000Z");
    expect(text.slice(2, 4)).toEqual(["Disc: Sintel", "VM: VTSM1 pgc 9 cell 1"]);
    expect(text[5]).toBe(`Log: 1 entries, 0 warnings, 0 errors (this is open ${log.run})`);
    expect(text[6]).toMatch(/ \+2\.5 s +INFO  VTSM1 pgc 9: menu, 3 buttons$/);
    expect(text[8]).toBe("VM trace: 1 lines");
    expect(text[9]).toMatch(/ \+2\.5 s +button 1: Play$/);
  });
});
