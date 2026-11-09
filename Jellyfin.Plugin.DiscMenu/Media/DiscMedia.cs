using System.Collections.Generic;

namespace Jellyfin.Plugin.DiscMenu.Media;

/// <summary>
/// Which Jellyfin item plays each file a pack's title cells name.
/// </summary>
/// <param name="Name">The series or movie's name.</param>
/// <param name="Titles">Each file the pack names, in the pack's order, found or not.</param>
public sealed record DiscMedia(string Name, IReadOnlyList<TitleMedia> Titles);
