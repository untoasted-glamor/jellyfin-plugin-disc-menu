namespace Jellyfin.Plugin.DiscMenu.Packs;

/// <summary>
/// One menu pack in an item's <c>.discmenus/</c> folder.
/// </summary>
/// <param name="Id">The pack's folder name, used in its file addresses.</param>
/// <param name="Name">The disc's name, from <c>disc.name</c> in its <c>menu.json</c>.</param>
/// <param name="Type">The disc's format, from <c>disc.type</c>: <c>dvd</c> or <c>bluray</c>.</param>
/// <param name="Season">The season the disc belongs to, for a series; <c>null</c> for a movie.</param>
public sealed record DiscInfo(string Id, string Name, string Type, int? Season);
