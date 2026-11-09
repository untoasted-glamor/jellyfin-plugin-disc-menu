namespace Jellyfin.Plugin.DiscMenu.Packs;

/// <summary>
/// One file a pack's title cells play.
/// </summary>
/// <param name="Episode">The episode number, for a series; a movie's cells have none.</param>
/// <param name="File">The file's name when the pack was made. Files are often renamed after a rip, so a series is
/// matched by episode number.</param>
public sealed record PackTitle(int? Episode, string File);
