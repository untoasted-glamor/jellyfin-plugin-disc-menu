// What a title cell hands to the web client's player, on its own and through Sintel's own menus.
import { describe, expect, it } from "vitest";
import type { DvdVm } from "../src/dvdvm.js";
import { describeHandoff, handoffFor, titleAction } from "../src/handoff.js";
import { MediaItem, mediaKey, PlayRequest } from "../src/media.js";
import { loadPack, press, settle, startVm } from "./helpers.js";

const ITEM = "41f6b840b8c91fba90ca5906e7544c90";
const SOURCE = "0123456789abcdef0123456789abcdef";
const item: MediaItem = {
  id: ITEM,
  name: "Sintel",
  mediaSourceId: SOURCE,
  streams: [
    { Index: 0, Type: "Subtitle", IsExternal: true, Language: "eng", FileName: "Sintel (2010).en.forced.srt" },
    { Index: 1, Type: "Video", IsExternal: false },
    { Index: 2, Type: "Audio", IsExternal: false, Language: "eng" },
    { Index: 3, Type: "Audio", IsExternal: false, Language: "deu" },
    { Index: 4, Type: "Subtitle", IsExternal: false, Language: "eng" },
    { Index: 5, Type: "Subtitle", IsExternal: false, Language: "deu" },
  ],
};

const req = (over: Partial<PlayRequest> = {}): PlayRequest => ({
  media: "F:Sintel (2010).mkv", title: "Sintel", offset: 0, length: 900, audioLang3: null, sidecar: null, subLang3: null,
  label: "title 2, chapter 1", ...over,
});

const NONE = { audio: 15, subp: 62 };

describe("the hand-off", () => {
  it("starts at the cell's offset in ticks, and at the top with no position", () => {
    expect(handoffFor(item, req(), NONE, NONE)).toEqual({ itemId: ITEM, mediaSourceId: SOURCE, name: "Sintel" });
    expect(handoffFor(item, req({ offset: 349.97 }), NONE, NONE).startTicks).toBe(3_499_700_000);
  });

  it("leaves audio and subtitles to Jellyfin when the viewer changed neither", () => {
    const h = handoffFor(item, req({ audioLang3: "deu", subLang3: "deu" }), { audio: 1, subp: 0x41 }, { audio: 1, subp: 0x41 });
    expect(h.audioIndex).toBeUndefined();
    expect(h.subtitleIndex).toBeUndefined();
  });

  it("sends the audio alone when only the audio changed", () => {
    const h = handoffFor(item, req({ audioLang3: "deu", subLang3: "deu" }), { audio: 1, subp: 62 }, NONE);
    expect([h.audioIndex, h.subtitleIndex]).toEqual([3, undefined]);
  });

  it("sends subtitles turned on in the menu, and -1 for subtitles turned off", () => {
    expect(handoffFor(item, req({ subLang3: "deu" }), { audio: 15, subp: 0x41 }, NONE).subtitleIndex).toBe(5);
    expect(handoffFor(item, req(), { audio: 15, subp: 0x01 }, { audio: 15, subp: 0x41 }).subtitleIndex).toBe(-1);
  });

  it("sends a paired subtitle file by its external index", () => {
    const h = handoffFor(item, req({ sidecar: ".en.forced.srt", subLang3: "eng" }), { audio: 15, subp: 0x40 }, NONE);
    expect(h.subtitleIndex).toBe(0);
  });

  it("sends nothing for a stream the file doesn't have", () => {
    const h = handoffFor(item, req({ audioLang3: "fra", subLang3: "fra" }), { audio: 2, subp: 0x42 }, NONE);
    expect([h.audioIndex, h.subtitleIndex]).toEqual([undefined, undefined]);
  });

  it("reads as one line", () => {
    expect(describeHandoff({ itemId: ITEM, name: "S01E03", startTicks: 25_000_000, audioIndex: 2, subtitleIndex: -1 }))
      .toBe("S01E03 from 2.5 s, audio stream 2, subtitles off");
    expect(describeHandoff({ itemId: ITEM, name: "S01E03" })).toBe("S01E03 from the start, audio Jellyfin's choice, subtitles Jellyfin's choice");
  });
});

describe("what a title cell does", () => {
  it.each([
    [{ embedded: true, mapped: false, inLibrary: false, pressed: true }, "missing"],
    [{ embedded: true, mapped: true, inLibrary: false, pressed: true }, "missing"],
    [{ embedded: true, mapped: true, inLibrary: true, pressed: false }, "intro"],
    [{ embedded: true, mapped: true, inLibrary: true, pressed: true }, "hand-off"],
    [{ embedded: false, mapped: true, inLibrary: false, pressed: false }, "show"],
    [{ embedded: false, mapped: false, inLibrary: false, pressed: true }, "missing"],
  ])("%o: %s", (o, want) => {
    expect(titleAction(o)).toBe(want);
  });
});

// Sintel through its own menus, the way the player builds a request from the VM (player.ts request()).
describe("Sintel's menus", () => {
  const pack = loadPack("sintel");
  const regs = (vm: DvdVm) => ({ audio: vm.sprm[1], subp: vm.sprm[2] });
  const requestOf = (vm: DvdVm): PlayRequest => {
    const m = vm.media!;
    const v = pack.vts[String(vm.state.vtsN)];
    const a = v.audio[vm.sprm[1]];
    const sp = vm.sprm[2];
    const sub = sp & 0x40 ? v.subp[sp & 0x3f] : undefined;
    return { ...req(), media: mediaKey(m), offset: m.offset, audioLang3: a?.lang3 ?? null, sidecar: sub?.sidecar ?? null, subLang3: sub?.lang3 ?? null };
  };
  const atMain = () => {
    const vm = startVm(pack);
    vm.cellEnded();
    settle(vm);
    return vm;
  };

  it("Play hands the film over from the top, with Jellyfin's own audio and subtitles", () => {
    const vm = atMain();
    const baseline = regs(vm);
    expect(press(vm, 1)).toBe("title");
    expect(handoffFor(item, requestOf(vm), regs(vm), baseline)).toEqual({ itemId: ITEM, mediaSourceId: SOURCE, name: "Sintel" });
  });

  it("Subtitles > German hands the film over with its German subtitles", () => {
    const vm = atMain();
    const baseline = regs(vm);
    press(vm, 3);
    expect(press(vm, 3)).toBe("title");
    const h = handoffFor(item, requestOf(vm), regs(vm), baseline);
    expect([h.subtitleIndex, h.audioIndex]).toEqual([5, undefined]);
  });
});
