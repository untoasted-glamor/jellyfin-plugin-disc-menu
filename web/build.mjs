// Builds the player page into dist/: index.html and style.css from static/, and player.js bundled. Also
// inject/button.js, the Disc menu button that runs inside the web client (a classic script, since JavaScript
// Injector's loader adds it as one). The plugin embeds dist/ in its DLL. `node build.mjs --serve [port]` rebuilds on
// change and serves web/ itself, so the page is at /dist/index.html and a fixture pack at ../fixtures/<disc>/.
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

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/player.ts"],
  outfile: "dist/player.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  define: { __PLAYER_VERSION__: JSON.stringify(version) },
  logLevel: "info",
};

/** @type {import("esbuild").BuildOptions} */
const button = {
  entryPoints: ["src/button.ts"],
  outfile: "dist/inject/button.js",
  bundle: true,
  format: "iife",
  // The web client's own floor; older TV browsers run it too.
  target: "es2018",
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  logLevel: "info",
};

if (serve) {
  await (await esbuild.context(button)).watch();
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await ctx.serve({ servedir: ".", host: "127.0.0.1", port });
  console.log(`player: http://127.0.0.1:${port}/dist/index.html?pack=../fixtures/sintel/`);
} else {
  await Promise.all([esbuild.build(options), esbuild.build(button)]);
}
