// @vitest-environment happy-dom
// The Stats panel: closed by default and remembered, the log with its filter and counts, Copy, and the wait switch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DebugLog } from "../src/debuglog.js";
import { OPEN_KEY, StatsPanel, StatsOptions } from "../src/stats.js";

function prefs() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

function panel(o: Partial<StatsOptions> = {}) {
  document.body.replaceChildren();
  const host = document.createElement("div");
  const toggle = document.createElement("button");
  document.body.append(host, toggle);
  const log = new DebugLog(null);
  const p = prefs();
  const stats = new StatsPanel(document, host, log, {
    embedded: true, state: () => ["Disc: Sintel", "VM: VTSM1 pgc 9 cell 1"], prefs: p, toggles: [toggle], ...o,
  });
  stats.restore();
  const items = () => [...stats.el.querySelectorAll(".stats-log li")].map((li) => li.querySelector(".text")!.textContent);
  const button = (id: string) => stats.el.querySelector<HTMLButtonElement>(`#${id}`)!;
  return { stats, log, prefs: p, toggle, items, button };
}

describe("the Stats panel", () => {
  beforeEach(() => vi.useRealTimers());

  it("is closed by default, and remembers being open", () => {
    const { stats, prefs: p } = panel();
    expect(stats.isOpen).toBe(false);
    stats.toggle();
    expect(p.map.get(OPEN_KEY)).toBe("1");
    const again = new StatsPanel(document, document.body, new DebugLog(null), {
      embedded: false, state: () => [], prefs: p, toggles: [],
    });
    again.restore();
    expect(again.isOpen).toBe(true);
    stats.close();
    expect(p.map.get(OPEN_KEY)).toBe("0");
  });

  it("opens even where the browser refuses localStorage", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const { stats } = panel({ prefs: broken });
    expect(() => stats.open()).not.toThrow();
    expect(stats.isOpen).toBe(true);
  });

  it("shows the live state and the log, and adds entries as they come", () => {
    const { stats, log, items } = panel();
    log.add("info", "VTSM1 pgc 9: menu, 3 buttons");
    stats.open();
    expect(stats.el.querySelector(".stats-state")!.textContent).toBe("Disc: Sintel\nVM: VTSM1 pgc 9 cell 1");
    log.add("warn", "Title 8 chapter 1: not in the library (70.1 s), skipped");
    expect(items()).toEqual(["VTSM1 pgc 9: menu, 3 buttons", "Title 8 chapter 1: not in the library (70.1 s), skipped"]);
    expect(stats.el.querySelector(".stats-log li:last-child")!.className).toBe("lvl-warn");
  });

  it("filters to warnings and errors, or to the VM trace", () => {
    const { stats, log, items, button } = panel();
    log.add("info", "menu");
    log.add("warn", "skipped");
    log.add("error", "couldn't load");
    log.trace("PGC VTSM1 pgc 9");
    stats.open();
    button("stats-f-problems").click();
    expect(items()).toEqual(["skipped", "couldn't load"]);
    expect(button("stats-f-problems").getAttribute("aria-pressed")).toBe("true");
    button("stats-f-trace").click();
    expect(items()).toEqual(["PGC VTSM1 pgc 9"]);
    log.trace("button 1: Play");
    expect(items()).toEqual(["PGC VTSM1 pgc 9", "button 1: Play"]);
  });

  it("counts warnings and errors in its title, with a dot on Stats until the panel is opened", () => {
    const { stats, log, toggle } = panel();
    log.add("warn", "a");
    log.add("error", "b");
    expect(stats.el.querySelector(".stats-title")!.textContent).toBe("Stats: 1 warning, 1 error");
    expect(toggle.classList.contains("dot")).toBe(true);
    stats.open();
    expect(toggle.classList.contains("dot")).toBe(false);
    log.add("warn", "while open");
    stats.close();
    expect(toggle.classList.contains("dot")).toBe(false);
    log.add("info", "only info");
    expect(toggle.classList.contains("dot")).toBe(false);
  });

  it("copies the log as text, or selects it for copying by hand when the clipboard is refused", async () => {
    const copied: string[] = [];
    const ok = panel({ clipboard: async (t) => void copied.push(t) });
    ok.log.add("info", "menu");
    ok.stats.open();
    expect(await ok.stats.copy()).toBe("clipboard");
    expect(copied[0]).toContain("Disc: Sintel\nVM: VTSM1 pgc 9 cell 1");
    expect(copied[0]).toMatch(/INFO {2}menu$/m);
    expect(ok.stats.el.querySelector(".stats-note")!.textContent).toMatch(/^Copied \d+ lines\.$/);

    const refused = panel({ clipboard: () => Promise.reject(new Error("NotAllowedError")) });
    refused.stats.open();
    expect(await refused.stats.copy()).toBe("manual");
    const area = refused.stats.el.querySelector<HTMLTextAreaElement>(".stats-copy")!;
    expect(area.hidden).toBe(false);
    expect(area.value).toContain("Disc menu stats, copied");
    expect(document.activeElement).toBe(area);
  });

  it("has the wait switch in the overlay only, off at every open", () => {
    const changes: boolean[] = [];
    const { stats, button } = panel({ onWait: (on) => changes.push(on) });
    const w = button("stats-wait");
    expect(w.textContent).toBe("Wait before playing from menu: Off");
    expect(stats.wait).toBe(false);
    w.click();
    expect(stats.wait).toBe(true);
    expect(w.getAttribute("aria-checked")).toBe("true");
    expect(w.textContent).toBe("Wait before playing from menu: On");
    expect(changes).toEqual([true]);
    expect(panel({ embedded: false }).stats.el.querySelector("#stats-wait")).toBeNull();
  });

  it("moves along its buttons with Left and Right, and Back gives the focus back to the menu", () => {
    const { stats } = panel();
    stats.open(true);
    const first = document.activeElement;
    expect(stats.el.contains(first)).toBe(true);
    const key = (k: string, back = false) => {
      const e = new KeyboardEvent("keydown", { key: k, cancelable: true });
      return stats.key(e, back);
    };
    expect(key("ArrowRight")).toBe(true);
    expect(document.activeElement).not.toBe(first);
    expect(key("ArrowLeft")).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key("Enter")).toBe(false);
    expect(key("Backspace", true)).toBe(true);
    expect(stats.el.contains(document.activeElement)).toBe(false);
    expect(stats.isOpen).toBe(true);
  });

  it("shows an entry of an earlier open dimmed and marked", () => {
    const store = prefs();
    const first = new DebugLog(store as never, () => 1);
    first.add("warn", "Web client: opening the details page of S01E01 instead");
    first.flush();
    document.body.replaceChildren();
    const log = new DebugLog(store as never, () => 2);
    const stats = new StatsPanel(document, document.body, log, { embedded: true, state: () => [], prefs: prefs(), toggles: [] });
    stats.open();
    const li = stats.el.querySelector(".stats-log li")!;
    expect(li.className).toBe("lvl-warn earlier");
    expect(li.querySelector(".when")!.textContent).toMatch(/\(open 1\)$/);
  });
});
