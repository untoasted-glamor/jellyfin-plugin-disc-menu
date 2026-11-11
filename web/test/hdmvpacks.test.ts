// The HDMV VM on real Blu-ray packs: every hdmv-1 pack in the folder DISC_MENU_PACKS names (a maintainer's own discs,
// never committed). Skipped when it isn't set. Checks what holds for any disc: first play gets to a menu, every
// button on every page reachable from it ends in a menu, a hand-off to a cell the pack maps, or a clean stop (never
// the step limit), and after a hand-off ends the disc goes back to a menu without playing it again by itself.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discDefaults } from "../src/bdpage";
import { HdmvVm, type HdmvPack, type Status } from "../src/hdmvvm";

const root = process.env.DISC_MENU_PACKS ?? "";
const packs: [string, HdmvPack][] = root
  ? readdirSync(root)
      .filter((d) => existsSync(join(root, d, "menu.json")))
      .map((d) => [d, JSON.parse(readFileSync(join(root, d, "menu.json"), "utf8")) as HdmvPack] as [string, HdmvPack])
      .filter(([, p]) => p.schema === "hdmv-1")
  : [];

const where = (s: Status) => (s.kind === "menu" ? `${s.menu.key} p${s.menu.page.id}` : s.kind);

/** A VM replayed along `path` (button ids pressed from the first menu). */
function replay(pack: HdmvPack, path: number[]): HdmvVm {
  const vm = new HdmvVm(pack);
  vm.start();
  for (const id of path) {
    vm.select(id);
    vm.activate();
  }
  return vm;
}

describe.skipIf(!packs.length)("real Blu-ray packs", () => {
  for (const [name, pack] of packs) {
    describe(name, () => {
      it("first play gets to a menu", () => {
        expect(where(new HdmvVm(pack).start())).not.toMatch(/^(stopped|handoff)$/);
      });

      it("every reachable button ends in a menu, a mapped hand-off or a clean stop", () => {
        const seen = new Set<string>();
        const queue: number[][] = [[]];
        let pressed = 0;
        let handoffs = 0;
        while (queue.length && seen.size < 200) {
          const path = queue.shift()!;
          const vm = replay(pack, path);
          if (vm.status.kind !== "menu") continue;
          const at = where(vm.status);
          if (seen.has(at)) continue;
          seen.add(at);
          for (const b of vm.shownButtons()) {
            const w = replay(pack, path);
            w.select(b.button.id);
            const s = w.activate();
            pressed++;
            expect(s.kind === "stopped" ? s.why : "", `${at} button ${b.button.id}`).not.toBe("step limit");
            if (s.kind === "menu") queue.push([...path, b.button.id]);
            if (s.kind === "handoff") {
              handoffs++;
              expect(Object.values(pack.media[s.handoff.playlist].cells)).toContain(s.handoff.cell);
              // Back from the title: a menu, not the same title again by itself.
              const back = w.ended();
              expect(back.kind, `${at} button ${b.button.id} then ended`).not.toBe("handoff");
            }
          }
        }
        expect(pressed).toBeGreaterThan(0);
        expect(handoffs).toBeGreaterThan(0);
      });

      it("the disc's own default streams can be worked out", () => {
        expect(discDefaults(pack)).not.toBeNull();
      });
    });
  }
});
