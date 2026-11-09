// @vitest-environment happy-dom
// The page and the button put pack and server data in as text only. This fails the build on the calls that turn a
// string into markup or code, anywhere in the sources, and checks that a disc name made of markup shows as text.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DebugLog } from "../src/debuglog.js";
import { discButton } from "../src/dom.js";
import { StatsPanel } from "../src/stats.js";

const FORBIDDEN = [
  /\.innerHTML\b/,
  /\.outerHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write(ln)?\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bcreateContextualFragment\b/,
  /\bsetHTMLUnsafe\b/,
  /\bsrcdoc\b/,
  /\bjavascript:/i,
];

// Paths, not URL objects: happy-dom's URL isn't one node:fs takes.
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = (dir: string) =>
  readdirSync(join(web, dir))
    .filter((f) => /\.(ts|html|mjs)$/.test(f))
    .map((f) => ({ file: `${dir}/${f}`, text: readFileSync(join(web, dir, f), "utf8") }));

describe("no markup or code from strings", () => {
  for (const { file, text } of [...sources("src"), ...sources("static")]) {
    it(file, () => {
      const hits = text.split("\n").flatMap((line, i) => FORBIDDEN.filter((re) => re.test(line)).map((re) => `${i + 1}: ${re} in ${line.trim()}`));
      expect(hits).toEqual([]);
    });
  }

  it("plays no title on the page: no hls.js, no stream or transcode calls", () => {
    const hits = sources("src").filter(({ text }) => /from\s+"hls\.js|master\.m3u8|ActiveEncodings/.test(text)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it("shows a log entry and live state made of markup as text in the Stats panel", () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const log = new DebugLog(null);
    const stats = new StatsPanel(document, document.body, log, {
      embedded: true, state: () => [`Disc: ${evil}`], prefs: { getItem: () => null, setItem: () => {} }, toggles: [],
    });
    log.add("error", `Couldn't load the menu file ${evil}`);
    log.trace(evil);
    stats.open();
    expect(stats.el.querySelector("img")).toBeNull();
    expect(stats.el.querySelector(".stats-log .text")!.textContent).toBe(`Couldn't load the menu file ${evil}`);
    expect(stats.el.querySelector(".stats-state")!.textContent).toBe(`Disc: ${evil}`);
    stats.el.querySelector<HTMLButtonElement>("#stats-f-trace")!.click();
    expect(stats.el.querySelector("img")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    stats.close();
    stats.el.remove();
  });

  it("shows a disc name made of markup as text", () => {
    const name = '<img src=x onerror="window.pwned=1">';
    const b = discButton(document, { Id: "d1", Name: name, Type: "dvd" }, () => {});
    document.body.append(b);
    expect(b.textContent).toBe(name);
    expect(b.querySelector("img")).toBeNull();
    expect(b.children.length).toBe(0);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("keeps the season next to the name", () => {
    expect(discButton(document, { Id: "d2", Name: "Disc 2", Type: "dvd", Season: 1 }, () => {}).textContent).toBe("Disc 2 (season 1)");
  });
});
