// `node walk.mjs <menu.json> [--lang eng,jpn] [--max-pages N]`: walk a pack's menus (src/walk.ts) and print the
// result as one JSON document on stdout. The Node build of the walk back end, for ARM's menu_preview task.
import { readFileSync } from "node:fs";
import { walk } from "./walk";

declare const __PLAYER_VERSION__: string;

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!file || args.includes("--version")) {
  process.stdout.write(args.includes("--version") ? `${__PLAYER_VERSION__}\n` : "usage: walk.mjs <menu.json> [--lang eng,jpn] [--max-pages N]\n");
  process.exit(file || args.includes("--version") ? 0 : 2);
}
const pack = JSON.parse(readFileSync(file, "utf8"));
const languages = opt("--lang")?.split(",").filter(Boolean);
const maxPages = opt("--max-pages") ? Number(opt("--max-pages")) : undefined;
process.stdout.write(JSON.stringify({ version: __PLAYER_VERSION__, ...walk(pack, { languages, maxPages }) }) + "\n");
