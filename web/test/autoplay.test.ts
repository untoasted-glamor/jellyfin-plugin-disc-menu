// Menu media the browser won't play until the viewer taps: the Start button shows, a video moves muted meanwhile, and
// the tap plays everything with sound.
import { describe, expect, it, vi } from "vitest";
import { AutoplayGate, Playable } from "../src/autoplay.js";

const refused = () => Object.assign(new Error("no gesture"), { name: "NotAllowedError" });

/** A media element whose play() is refused until `allow` is set. */
function element(allowMuted = false) {
  const el = {
    muted: false,
    allow: false,
    plays: 0,
    play: vi.fn(function (this: void) {
      el.plays++;
      return el.allow || (allowMuted && el.muted) ? Promise.resolve() : Promise.reject(refused());
    }),
  };
  return el as typeof el & Playable;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the autoplay gate", () => {
  it("shows Start when the browser refuses, and the tap plays with sound", async () => {
    const onRefused = vi.fn();
    const gate = new AutoplayGate(onRefused);
    const audio = element();
    gate.play(audio, false);
    await settle();
    expect(onRefused).toHaveBeenCalledOnce();
    expect(gate.blocked).toBe(true);
    audio.allow = true;
    gate.resume();
    await settle();
    expect(audio.plays).toBe(2);
    expect(audio.muted).toBe(false);
    expect(gate.blocked).toBe(false);
  });

  it("plays a refused video muted until the tap", async () => {
    const gate = new AutoplayGate(() => {});
    const video = element(true);
    gate.play(video, true);
    await settle();
    expect(video.muted).toBe(true);
    expect(video.plays).toBe(2);
    gate.resume();
    expect(video.muted).toBe(false);
  });

  it("does nothing when the browser plays, or fails for another reason", async () => {
    const onRefused = vi.fn();
    const gate = new AutoplayGate(onRefused);
    const fine = element();
    fine.allow = true;
    gate.play(fine, true);
    const broken = { muted: false, play: () => Promise.reject(new Error("404")) };
    gate.play(broken, true);
    await settle();
    expect(onRefused).not.toHaveBeenCalled();
    expect(gate.blocked).toBe(false);
  });

  it("forgets what waited when the menu changes", async () => {
    const gate = new AutoplayGate(() => {});
    gate.play(element(), false);
    await settle();
    gate.clear();
    expect(gate.blocked).toBe(false);
  });
});
