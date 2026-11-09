// What the plugin's Media route reports, and how a title request maps to a file and its streams. No DOM and no
// hls.js, so the tests import it directly.
import type { MediaCell } from "./dvdvm.js";

export interface PlayRequest {
  /** Which file: "E<n>" for a series episode, "F:<file name>" for a movie (see mediaKey). */
  media: string;
  /** What the viewer sees for it: "S01E03" or the movie's file name. */
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

/** A series episode is found by its number (file names change after a rip); a movie by its file name. */
export const mediaKey = (m: MediaCell): string => (m.episode !== undefined ? `E${m.episode}` : `F:${m.file}`);

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
    const key = mediaKey({ offset: 0, file: t.File, episode: t.Episode });
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
