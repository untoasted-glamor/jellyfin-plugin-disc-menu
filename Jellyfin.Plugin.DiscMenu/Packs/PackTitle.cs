using System.Globalization;
using System.IO;

namespace Jellyfin.Plugin.DiscMenu.Packs;

/// <summary>
/// One library item a pack's title cells play: a series episode (by season and number), a series extra (by its path
/// under the show folder) or a movie file (by name).
/// </summary>
/// <param name="Episode">The episode number, for a series; a movie's cells and an extra have none.</param>
/// <param name="File">The file's name when the pack was made. Files are often renamed after a rip, so an episode is
/// matched by season and number.</param>
/// <param name="Season">The episode's season when it isn't the pack's (a special is season 0); <c>null</c> for the
/// pack's own season.</param>
/// <param name="Extra">The extra's path under the show folder, such as <c>trailers/Trailers.mkv</c>; matched by file
/// name among the series' extras.</param>
public sealed record PackTitle(int? Episode, string File, int? Season = null, string? Extra = null)
{
    /// <summary>
    /// Gets the key the player matches cells by: <c>X:&lt;extra&gt;</c> for an extra, <c>S&lt;s&gt;E&lt;n&gt;</c> for an
    /// episode with its own season, <c>E&lt;n&gt;</c> for one in the pack's season, <c>F:&lt;file&gt;</c> otherwise.
    /// </summary>
    public string Key => Extra is not null
        ? "X:" + Extra
        : Episode is int number
            ? (Season is int season ? string.Create(CultureInfo.InvariantCulture, $"S{season}E{number}") : string.Create(CultureInfo.InvariantCulture, $"E{number}"))
            : "F:" + File;

    /// <summary>
    /// Gets the extra's file name, the part matched against the series' extras.
    /// </summary>
    internal string? ExtraFileName => Extra is null ? null : Path.GetFileName(Extra.Replace('\\', '/'));
}
