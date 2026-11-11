// What the plugin's Media route reports, and how a title request maps to a file and its streams. No DOM and no
// hls.js, so the tests import it directly.
import type { MediaCell } from "./dvdvm.js";

export interface PlayRequest {
  /** Which item: "E<n>", "S<s>E<n>" or "X:<extra path>" for a series, "F:<file name>" for a movie (see mediaKey). */
  media: string;
  /** What the viewer sees for it: "S01E03", "S00E01", or the extra's or movie's file name. */
  title: string;
  offset: number;
  /** How long the file is, as far as the pack knows (the end of its last cell). */
  length: number;
  audioLang3: string | null;
  /** The chosen subtitle: its sidecar file's suffix when the pack pairs one, and its language. */
  sidecar: string | null;
  subLang3: string | null;
  label: string;
}

/**
 * The key a cell's item is found by, the same one the plugin's Media route reports: an extra by its path ("X:"), a
 * series episode by its number ("E<n>" in the pack's season, "S<s>E<n>" in another, such as season 0 for a special;
 * file names change after a rip), else a movie by its file name ("F:").
 */
export function mediaKey(m: Partial<MediaCell> & Pick<MediaCell, "file">): string {
  if (m.extra != null) return `X:${m.extra}`;
  if (m.episode != null) return m.season != null ? `S${m.season}E${m.episode}` : `E${m.episode}`;
  return `F:${m.file}`;
}

export const requestKey = (r: PlayRequest) => `${r.media}|${r.audioLang3}|${r.sidecar}|${r.subLang3}`;

/** How a request's subtitle reads in the status line. */
export const subtitleLabel = (r: PlayRequest) => r.sidecar ?? r.subLang3 ?? "off";

/** An audio or subtitle stream, as the plugin's Media route reports it. */
export interface Stream {
  Index: number;
  Type: string;
  Language?: string;
  IsExternal: boolean;
  /** An external stream's file name (no folder). */
  FileName?: string;
}

/** One file a pack names and what plays it (the plugin's Media route). One the library lacks has no ItemId. */
export interface TitleMedia {
  Episode?: number;
  /** Set when the pack gave the episode a season of its own (0 for a special). */
  Season?: number;
  /** An extra's path under the show folder, as the pack gives it. */
  Extra?: string;
  File: string;
  ItemId?: string;
  Name?: string;
  MediaSourceId?: string;
  Streams?: Stream[];
}

export interface DiscMedia {
  Name: string;
  Titles: TitleMedia[];
}

/** A pack next to a series or movie (the plugin's disc list). */
export interface DiscInfo {
  Id: string;
  Name: string;
  Type: string;
  Season?: number;
}

export interface MediaItem {
  id: string;
  name: string;
  mediaSourceId: string;
  streams: Stream[];
}

/** The files the Media route found, keyed like the pack's cells (mediaKey). */
export function mediaItems(media: DiscMedia): Map<string, MediaItem> {
  const items = new Map<string, MediaItem>();
  for (const t of media.Titles) {
    if (!t.ItemId || !t.MediaSourceId) continue;
    const key = mediaKey({ file: t.File, episode: t.Episode, season: t.Season, extra: t.Extra });
    items.set(key, { id: t.ItemId, name: t.Name ?? t.File, mediaSourceId: t.MediaSourceId, streams: t.Streams ?? [] });
  }
  return items;
}

/** A path inside a pack as a URL path: each segment encoded. */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * The Jellyfin stream indexes a request maps to (null = Jellyfin's default / none). Audio is the first stream in
 * the chosen language. A subtitle is the external file whose name ends with the pack's sidecar suffix, else the
 * file's first internal subtitle stream in the chosen language.
 */
export function pickStreams(streams: Stream[], r: PlayRequest): { audio: number | null; sub: number | null } {
  const audio = r.audioLang3
    ? (streams.find((s) => s.Type === "Audio" && s.Language === r.audioLang3)?.Index ?? null)
    : null;
  const subs = streams.filter((s) => s.Type === "Subtitle");
  const sub =
    (r.sidecar ? subs.find((s) => s.IsExternal && (s.FileName ?? "").endsWith(r.sidecar!)) : undefined) ??
    (r.subLang3 ? subs.find((s) => !s.IsExternal && s.Language === r.subLang3) : undefined);
  return { audio, sub: sub?.Index ?? null };
}
