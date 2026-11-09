# Disc Menu for Jellyfin

A Jellyfin plugin that plays a DVD's or Blu-ray's own title screen and menus, next to the episodes they start.

**Status:** v0.2 plays a DVD's menus in a browser. A series or movie with a menu pack gets a "Disc menu" link;
the player page signs in as the viewer, runs the disc's own menus and plays the titles they start from the
library, with the audio and subtitles chosen in the menus. Blu-ray menus, a phone as the remote for a TV and a
button next to Play come in later releases. Nothing in this repo makes packs yet; see [Menu packs](#menu-packs) for
what one holds.

Requires Jellyfin 12.0 or later.

## Install

1. In Jellyfin, open **Dashboard > Plugins > Catalog**, then the **gear icon** (manage repositories).
2. Click **+**, name it `Disc Menu`, and paste this repository URL:

   ```
   https://raw.githubusercontent.com/untoasted-glamor/jellyfin-plugin-disc-menu/main/manifest.json
   ```

3. Click **Save**, go back to **Catalog**, find **Disc Menu** and click **Install**.
4. Restart Jellyfin from the Dashboard. The plugin loads only after a restart.

Updates appear in the same Catalog, and each one needs a restart too. To remove the plugin, open
**Dashboard > Plugins > Disc Menu > Uninstall** and restart.

## Menu packs

Each disc's menus live in a menu pack: a folder `.discmenus/<disc>/` in the series or movie folder, holding
`menu.json` (the disc's own navigation commands and buttons) and the menu images and videos it names. Jellyfin
skips dot-folders when it scans, so a pack never shows up as a library item.

The plugin serves:

| Route | Login | Does |
|---|---|---|
| `GET /DiscMenu/Player/` and its files | None | The player page, embedded in the DLL. |
| `GET /DiscMenu/Items/{itemId}/Discs` | Yes, and the user must see the item | The item's packs: `Id` (folder name), `Name`, `Type` (`dvd`), and `Season` for a series. |
| `GET /DiscMenu/Items/{itemId}/Discs/{disc}/Files/{path}` | Yes, and the user must see the item | One file of a pack, with range requests. A path that leads out of the pack, once links are followed, is refused. |
| `GET /DiscMenu/Items/{itemId}/Discs/{disc}/Media` | Yes, and the user must see the item | Which library item plays each file the pack's titles name: `ItemId`, `MediaSourceId` and its audio and subtitle `Streams` with Jellyfin's indexes. A file the library lacks has no `ItemId`. |

A login is a token in `Authorization: MediaBrowser Token="..."`, or `ApiKey=` in the URL for images and video.

A series' files are found by the pack's `disc.season` and each title's episode number, because files are often
renamed after a rip. A movie's are found by file name among its versions; a pack that plays a single file plays
the movie even when the file was renamed. Stream indexes are looked up on every request, since an added subtitle
file shifts them.

The player page opens a pack with `DiscMenu/Player/?item={itemId}`, and `&disc={disc}` when the item has more
than one. Every call uses the viewer's own account:

- In a browser the page shares the web client's origin, so it reuses the web client's saved login for the same
  server (`jellyfin_credentials` in local storage, matched by server id). That token is sent on its own, with no
  client or device name, so the web client's entry under Dashboard > Devices keeps its name.
- Otherwise the page signs in itself: a Quick Connect code to approve from a signed-in device (user settings >
  Quick Connect), when the server has Quick Connect on, or a user name and password. It keeps that login in the
  browser's local storage and shows up under Dashboard > Devices as Disc Menu. Sign out ends it on the server.
- "Use another account" leaves the web client signed in.

A series or movie with at least one readable pack gets a "Disc menu" entry under its Links, pointing at
`{base URL}/DiscMenu/Player/?item={itemId}`. The address starts at the server's root, so the page opens on the
web client's own origin. Whether a folder has packs is cached for a minute, so a pack added or removed shows in
the Links within a minute.

## Build

Needs the .NET 10 SDK and Node.js 22. The plugin embeds the player page, so build `web/` first.

```bash
(cd web && npm ci --ignore-scripts && npm run build)
dotnet test --solution Jellyfin.Plugin.DiscMenu.slnx
dotnet publish Jellyfin.Plugin.DiscMenu/Jellyfin.Plugin.DiscMenu.csproj -c Release -o publish
```

The C# tests are in [tests/](tests/) (xUnit v3 on Microsoft.Testing.Platform, opted into in `global.json`).

### Menu player page

The player page is TypeScript in [web/](web/): a DVD VM that runs a disc's own navigation commands
(`src/dvdvm.ts`, after libdvdnav), the menu renderer (`src/player.ts`) and playback through Jellyfin's HLS
stream with hls.js (`src/playback.ts`). `npm run build` writes the page to `web/dist/`, with hls.js bundled.

```bash
cd web
npm ci --ignore-scripts
npm run check    # type check
npm test         # VM scenarios on the Sintel fixture
npm run serve    # http://127.0.0.1:8098/dist/index.html?pack=../fixtures/sintel/ (no login, stub playback)
```

Test fixtures come from the Sintel DVD only (see [NOTICE](NOTICE)).

## Release

Push a tag like `v0.1.0` on `main`. The annotated tag's message becomes the changelog. The
[release workflow](.github/workflows/release.yml) builds the plugin, attaches the zip to a GitHub Release
and adds the version to `manifest.json` on `main`.

```bash
git tag -a v0.1.0 -m "First release: an empty plugin that installs from the Catalog"
git push origin v0.1.0
```

## License

GPL-3.0, like Jellyfin and its plugin template. Third-party material is listed in [NOTICE](NOTICE).
