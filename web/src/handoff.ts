// What a title cell hands to the web client's player. No DOM, so the tests import it directly.
//
// The start is the cell's offset in the file. Audio and subtitles go only when the viewer changed them in the disc's
// menus: the player keeps SPRM 1 (audio) and SPRM 2 (subpicture) as they were at the viewer's first button press, and
// a stream whose register still holds that value is left to Jellyfin, which picks from the user's language settings.
// Subtitles the viewer turned off go as -1.
import type { PlayHandoff } from "./embed.js";
import { MediaItem, pickStreams, PlayRequest } from "./media.js";

/** The disc's audio and subpicture registers (SPRM 1 and 2). */
export interface StreamRegs {
  audio: number;
  subp: number;
}

const TICKS_PER_SECOND = 10_000_000;
/** SPRM 2's "subpicture shown" bit. */
const SUBP_ON = 0x40;

/**
 * What the page does with a title cell. A cell the pack doesn't map, or (in the overlay) one the library lacks, is
 * skipped. In the overlay, a title the disc starts before the viewer pressed any menu button (logos and warnings at
 * first play) is skipped whole, and any other goes to the web client's player. The page opened by hand shows what
 * would play.
 */
export function titleAction(o: { embedded: boolean; mapped: boolean; inLibrary: boolean; pressed: boolean }):
  | "missing"
  | "intro"
  | "hand-off"
  | "show" {
  if (!o.mapped || (o.embedded && !o.inLibrary)) return "missing";
  if (!o.embedded) return "show";
  return o.pressed ? "hand-off" : "intro";
}

export function handoffFor(item: MediaItem, r: PlayRequest, now: StreamRegs, baseline: StreamRegs): PlayHandoff {
  const h: PlayHandoff = { itemId: item.id, name: item.name.slice(0, 200) };
  if (item.mediaSourceId) h.mediaSourceId = item.mediaSourceId;
  const ticks = Math.round(r.offset * TICKS_PER_SECOND);
  if (ticks > 0) h.startTicks = ticks;
  const picked = pickStreams(item.streams, r);
  if (now.audio !== baseline.audio && picked.audio !== null) h.audioIndex = picked.audio;
  if (now.subp !== baseline.subp) {
    if (!(now.subp & SUBP_ON)) h.subtitleIndex = -1;
    else if (picked.sub !== null) h.subtitleIndex = picked.sub;
  }
  return h;
}

/** One line for the status and the log. */
export function describeHandoff(h: PlayHandoff): string {
  const at = h.startTicks ? `${(h.startTicks / TICKS_PER_SECOND).toFixed(1)} s` : "the start";
  const audio = h.audioIndex === undefined ? "Jellyfin's choice" : `stream ${h.audioIndex}`;
  const subs = h.subtitleIndex === undefined ? "Jellyfin's choice" : h.subtitleIndex === -1 ? "off" : `stream ${h.subtitleIndex}`;
  return `${h.name} from ${at}, audio ${audio}, subtitles ${subs}`;
}
