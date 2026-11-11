using System.Collections.Generic;

namespace Jellyfin.Plugin.DiscMenu.Packs;

/// <summary>
/// The library items a pack's title cells play, from its <c>menu.json</c>.
/// </summary>
/// <param name="Season">The series season the disc belongs to; <c>null</c> for a movie.</param>
/// <param name="Titles">Each item once: the pack's season's episodes in number order, then other seasons' (specials
/// first), then extras by path, then files by name.</param>
public sealed record PackTitles(int? Season, IReadOnlyList<PackTitle> Titles);
