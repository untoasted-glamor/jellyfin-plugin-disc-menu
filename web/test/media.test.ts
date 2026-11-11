// The plugin's Media route answer as the player reads it: files keyed like the pack's cells, and which Jellyfin
// streams a title request picks.
import { expect, test } from "vitest";
import { encodePath, mediaItems, mediaKey, pickStreams, type PlayRequest, type Stream } from "../src/media.js";

const request = (r: Partial<PlayRequest>): PlayRequest => ({
  media: "F:Sintel (2010).mkv", title: "Sintel (2010).mkv", offset: 0, length: 888,
  audioLang3: null, sidecar: null, subLang3: null, label: "title 2, chapter 1", ...r,
});

test("files the library has are keyed like the pack's cells; missing ones are left out", () => {
  const items = mediaItems({
    Name: "Show",
    Titles: [
      { Episode: 1, File: "old 1.mkv", ItemId: "e1", Name: "Pilot", MediaSourceId: "s1", Streams: [] },
      { Episode: 2, File: "old 2.mkv" },
      { File: "Extras.mkv", ItemId: "m", MediaSourceId: "s3" },
    ],
  });

  expect([...items.keys()]).toEqual(["E1", "F:Extras.mkv"]);
  expect(items.get("E1")).toEqual({ id: "e1", name: "Pilot", mediaSourceId: "s1", streams: [] });
  expect(items.get("F:Extras.mkv")?.name).toBe("Extras.mkv");
  expect(mediaKey({ offset: 12, file: "renamed.mkv", episode: 1 })).toBe("E1");
});

test("specials and extras get keys of their own, matching the Media route's", () => {
  expect(mediaKey({ offset: 0, file: "sp.mkv", episode: 1, season: 0 })).toBe("S0E1");
  expect(mediaKey({ offset: 0, file: "e1.mkv", episode: 1 })).toBe("E1");
  expect(mediaKey({ offset: 0, file: "Trailers.mkv", extra: "trailers/Trailers.mkv", dur: 423.34 })).toBe(
    "X:trailers/Trailers.mkv",
  );
  // An extra wins over an episode number; a season with no episode number means nothing.
  expect(mediaKey({ offset: 0, file: "x.mkv", episode: 3, extra: "extras/x.mkv" })).toBe("X:extras/x.mkv");
  expect(mediaKey({ offset: 0, file: "loose.mkv", season: 0 })).toBe("F:loose.mkv");

  const items = mediaItems({
    Name: "Show",
    Titles: [
      { Episode: 1, File: "e1.mkv", ItemId: "e1", MediaSourceId: "s1" },
      { Episode: 1, Season: 0, File: "sp1.mkv", ItemId: "sp1", Name: "Special", MediaSourceId: "s2" },
      { File: "Trailers.mkv", Extra: "trailers/Trailers.mkv", ItemId: "t", Name: "Trailers", MediaSourceId: "s3" },
      { File: "Gone.mkv", Extra: "extras/Gone.mkv" },
      // Jellyfin may send unset fields as null.
      { Episode: 2, Season: null as unknown as undefined, File: "e2.mkv", ItemId: "e2", MediaSourceId: "s4" },
    ],
  });
  expect([...items.keys()]).toEqual(["E1", "S0E1", "X:trailers/Trailers.mkv", "E2"]);
  expect(items.get("S0E1")?.name).toBe("Special");
});

const streams: Stream[] = [
  { Index: 1, Type: "Audio", Language: "eng", IsExternal: false },
  { Index: 2, Type: "Audio", Language: "deu", IsExternal: false },
  { Index: 3, Type: "Subtitle", Language: "deu", IsExternal: false },
  { Index: 4, Type: "Subtitle", Language: "deu", IsExternal: false },
  { Index: 5, Type: "Subtitle", Language: "eng", IsExternal: true, FileName: "Show S01E01.en.forced.srt" },
];

test("audio and an internal subtitle are picked by language", () => {
  expect(pickStreams(streams, request({ audioLang3: "deu", subLang3: "deu" }))).toEqual({ audio: 2, sub: 3 });
  expect(pickStreams(streams, request({ audioLang3: "fra", subLang3: "fra" }))).toEqual({ audio: null, sub: null });
  expect(pickStreams(streams, request({}))).toEqual({ audio: null, sub: null });
});

test("a pack's sidecar subtitle is the external file with that suffix", () => {
  expect(pickStreams(streams, request({ sidecar: ".en.forced.srt", subLang3: "eng" }))).toEqual({ audio: null, sub: 5 });
  // No external file with the suffix: an internal stream in the language, never an external one by language.
  expect(pickStreams(streams, request({ sidecar: ".de.srt", subLang3: "deu" })).sub).toBe(3);
  expect(pickStreams(streams, request({ sidecar: ".fr.srt", subLang3: "eng" })).sub).toBeNull();
});

test("pack paths are encoded per segment", () => {
  expect(encodePath("menus/a b#1.png")).toBe("menus/a%20b%231.png");
});
