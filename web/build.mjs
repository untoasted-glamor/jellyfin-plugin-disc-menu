// Builds the player page into dist/: index.html and style.css from static/, player.js bundled with hls.js
// (its light build: Jellyfin picks the audio and burns in subtitles, so no alternate renditions are needed),
// and hls.js's licence. The plugin embeds dist/ in its DLL. `node build.mjs --serve [port]` rebuilds on change and serves
// web/ itself, so the page is at /dist/index.html and a fixture pack at ../fixtures/<disc>/.
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const serve = process.argv.includes("--serve");
const port = Number(process.argv[process.argv.indexOf("--serve") + 1]) || 8098;
const { version } = JSON.parse(await readFile("package.json", "utf8"));

await rm("dist", { recursive: true, force: true });
await mkdir("dist");
await cp("static", "dist", { recursive: true });
await cp("node_modules/hls.js/LICENSE", "dist/hls.js.LICENSE.txt");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/player.ts"],
  outfile: "dist/player.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  // The source imports "hls.js" for its types; the bundle gets the light build.
  alias: { "hls.js": "hls.js/light" },
  define: { __PLAYER_VERSION__: JSON.stringify(version) },
  logLevel: "info",
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await ctx.serve({ servedir: ".", host: "127.0.0.1", port });
  console.log(`player: http://127.0.0.1:${port}/dist/index.html?pack=../fixtures/sintel/`);
} else {
  await esbuild.build(options);
}
