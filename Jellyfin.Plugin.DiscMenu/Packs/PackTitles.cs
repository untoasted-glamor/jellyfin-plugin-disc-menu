using System.Collections.Generic;

namespace Jellyfin.Plugin.DiscMenu.Packs;

/// <summary>
/// The files a pack's title cells play, from its <c>menu.json</c>.
/// </summary>
/// <param name="Season">The series season the disc belongs to; <c>null</c> for a movie.</param>
/// <param name="Titles">Each file once: episodes in number order, then files by name.</param>
public sealed record PackTitles(int? Season, IReadOnlyList<PackTitle> Titles);
