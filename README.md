# Disc Menu for Jellyfin

A Jellyfin plugin that plays a DVD's or Blu-ray's own title screen and menus, next to the episodes they start.

**Status:** v0.1 is an empty plugin. It installs from the Catalog and shows a settings page, and nothing else yet.
It proves the release and install path before the menu player moves in.

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

## Build

Needs the .NET 10 SDK.

```bash
dotnet publish Jellyfin.Plugin.DiscMenu/Jellyfin.Plugin.DiscMenu.csproj -c Release -o publish
```

## Release

Push a tag like `v0.1.0` on `main`. The annotated tag's message becomes the changelog. The
[release workflow](.github/workflows/release.yml) builds the plugin, attaches the zip to a GitHub Release
and adds the version to `manifest.json` on `main`.

```bash
git tag -a v0.1.0 -m "First release: an empty plugin that installs from the Catalog"
git push origin v0.1.0
```

## License

GPL-3.0, like Jellyfin and its plugin template.
