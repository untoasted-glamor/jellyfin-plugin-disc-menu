using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.DiscMenu.Packs;

/// <summary>
/// Finds the menu packs next to a series or movie and the files inside them. A pack is a folder
/// <c>.discmenus/&lt;disc&gt;/</c> in the item's folder, holding <c>menu.json</c> and the menu images and videos it
/// names. Jellyfin's built-in ignore list skips dot-folders, so packs never become library items.
/// </summary>
public sealed class PackStore
{
    /// <summary>
    /// The folder, inside a series or movie folder, that holds its menu packs.
    /// </summary>
    public const string FolderName = ".discmenus";

    /// <summary>
    /// The file in each pack that describes the disc.
    /// </summary>
    public const string MenuFile = "menu.json";

    // Links are followed at most this deep, as Linux does, so a loop of links ends.
    private const int MaxLinkDepth = 40;

    private static readonly JsonSerializerOptions _jsonOptions = new() { PropertyNameCaseInsensitive = false };

    private readonly ILogger<PackStore> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PackStore"/> class.
    /// </summary>
    /// <param name="logger">The logger.</param>
    public PackStore(ILogger<PackStore> logger)
    {
        _logger = logger;
    }

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>
    /// Lists the packs in an item's folder, sorted by folder name. A pack whose <c>menu.json</c> is missing,
    /// unreadable or lacks the disc's name and format is left out and logged.
    /// </summary>
    /// <param name="itemFolder">The series or movie folder.</param>
    /// <returns>The packs found; empty when the folder has none.</returns>
    public IReadOnlyList<DiscInfo> ListDiscs(string itemFolder)
    {
        var packsFolder = Path.Combine(itemFolder, FolderName);
        string[] folders;
        try
        {
            folders = Directory.Exists(packsFolder) ? Directory.GetDirectories(packsFolder) : [];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Can't list the menu packs in {Folder}", packsFolder);
            return [];
        }

        var discs = new List<DiscInfo>();
        foreach (var disc in folders.Select(Path.GetFileName).Order(StringComparer.Ordinal))
        {
            if (disc is null || !IsSafeName(disc))
            {
                continue;
            }

            var menu = ResolveFile(itemFolder, disc, MenuFile);
            if (menu is null)
            {
                _logger.LogWarning("Menu pack {Disc} in {Folder} has no {MenuFile}", disc, packsFolder, MenuFile);
                continue;
            }

            var info = ReadDisc(disc, menu);
            if (info is not null)
            {
                discs.Add(info);
            }
        }

        return discs;
    }

    /// <summary>
    /// Finds a file inside one pack. Refuses, by returning <c>null</c>, any path that names a parent or hidden
    /// folder, is absolute, holds a backslash, colon or percent sign, or leads out of the pack's folder once links
    /// are followed.
    /// </summary>
    /// <param name="itemFolder">The series or movie folder.</param>
    /// <param name="disc">The pack's folder name.</param>
    /// <param name="relativePath">The file's path inside the pack, with <c>/</c> between folders.</param>
    /// <returns>The file's full path with every link resolved, or <c>null</c>.</returns>
    public string? ResolveFile(string itemFolder, string disc, string? relativePath)
    {
        if (!IsSafeName(disc) || string.IsNullOrEmpty(relativePath))
        {
            return null;
        }

        var segments = relativePath.Split('/');
        if (!segments.All(IsSafeName))
        {
            return null;
        }

        var root = RealPath(Path.GetFullPath(Path.Combine(itemFolder, FolderName, disc)));
        if (root is null || !Directory.Exists(root))
        {
            return null;
        }

        var file = RealPath(Path.Combine([root, .. segments]));
        if (file is null
            || !file.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, PathComparison)
            || !File.Exists(file))
        {
            return null;
        }

        return file;
    }

    /// <summary>
    /// Reads which files a pack's title cells play: each distinct episode number, or file name when a cell has no
    /// episode. A cell without a file name is skipped.
    /// </summary>
    /// <param name="itemFolder">The series or movie folder.</param>
    /// <param name="disc">The pack's folder name.</param>
    /// <returns>The pack's season and files, or <c>null</c> when the pack is missing or its <c>menu.json</c>
    /// can't be read.</returns>
    public PackTitles? ReadTitles(string itemFolder, string disc)
    {
        var menu = ResolveFile(itemFolder, disc, MenuFile);
        if (menu is null)
        {
            return null;
        }

        try
        {
            using var stream = File.OpenRead(menu);
            var pack = JsonSerializer.Deserialize<PackMedia>(stream, _jsonOptions);
            if (pack is null)
            {
                return null;
            }

            var cells = (pack.Media ?? []).Values
                .SelectMany(pgc => (pgc.Cells ?? []).Values)
                .Where(cell => !string.IsNullOrEmpty(cell.File));
            var titles = cells
                .Select(cell => new PackTitle(cell.Episode, cell.File!))
                .DistinctBy(title => title.Episode?.ToString(CultureInfo.InvariantCulture) ?? "F:" + title.File)
                .OrderBy(title => title.Episode is null)
                .ThenBy(title => title.Episode)
                .ThenBy(title => title.File, StringComparer.Ordinal)
                .ToList();
            return new PackTitles(pack.Disc?.Season, titles);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _logger.LogWarning(ex, "Can't read the titles of menu pack {Disc} at {Path}", disc, menu);
            return null;
        }
    }

    /// <summary>
    /// Whether a disc folder name or one segment of a pack path is safe to join to a folder: not empty, no
    /// leading dot (so no <c>.</c>, <c>..</c> or hidden files), and none of <c>/ \ : %</c> or control characters.
    /// </summary>
    /// <param name="name">The name.</param>
    /// <returns><c>true</c> when it is safe.</returns>
    internal static bool IsSafeName(string name)
    {
        return name.Length is > 0 and <= 255
            && name[0] != '.'
            && !name.Any(c => c is '/' or '\\' or ':' or '%' || char.IsControl(c));
    }

    /// <summary>
    /// Resolves every link in an absolute path, like <c>realpath</c>: each folder and the last part are replaced by
    /// what they link to, until none is a link.
    /// </summary>
    /// <param name="path">An absolute, normalized path.</param>
    /// <returns>The path with no links in it, or <c>null</c> when links nest deeper than 40.</returns>
    internal static string? RealPath(string path)
    {
        for (var depth = 0; depth <= MaxLinkDepth; depth++)
        {
            var next = ResolveFirstLink(path);
            if (next is null)
            {
                return path;
            }

            path = next;
        }

        return null;
    }

    // Replaces the first link in the path by its target and returns the new path, or null when there is no link.
    private static string? ResolveFirstLink(string path)
    {
        var root = Path.GetPathRoot(path) ?? string.Empty;
        var parts = path[root.Length..].Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries);
        var current = root;
        for (var i = 0; i < parts.Length; i++)
        {
            var candidate = Path.Combine(current, parts[i]);
            var target = new FileInfo(candidate).LinkTarget;
            if (target is not null)
            {
                var resolved = Path.GetFullPath(target, current);
                return Path.Combine([resolved, .. parts[(i + 1)..]]);
            }

            current = candidate;
        }

        return null;
    }

    private DiscInfo? ReadDisc(string disc, string menuPath)
    {
        try
        {
            using var stream = File.OpenRead(menuPath);
            var header = JsonSerializer.Deserialize<PackHeader>(stream, _jsonOptions);
            if (header?.Disc is { Name: { Length: > 0 } name, Type: { Length: > 0 } type })
            {
                return new DiscInfo(disc, name, type, header.Disc.Season);
            }

            _logger.LogWarning("Menu pack {Disc} at {Path} lacks disc.name or disc.type", disc, menuPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _logger.LogWarning(ex, "Can't read menu pack {Disc} at {Path}", disc, menuPath);
        }

        return null;
    }

    private sealed class PackHeader
    {
        [JsonPropertyName("disc")]
        public PackDisc? Disc { get; set; }
    }

    private sealed class PackDisc
    {
        [JsonPropertyName("type")]
        public string? Type { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("season")]
        public int? Season { get; set; }
    }

    private sealed class PackMedia
    {
        [JsonPropertyName("disc")]
        public PackDisc? Disc { get; set; }

        [JsonPropertyName("media")]
        public Dictionary<string, PackMediaPgc>? Media { get; set; }
    }

    private sealed class PackMediaPgc
    {
        [JsonPropertyName("cells")]
        public Dictionary<string, PackMediaCell>? Cells { get; set; }
    }

    private sealed class PackMediaCell
    {
        [JsonPropertyName("file")]
        public string? File { get; set; }

        [JsonPropertyName("episode")]
        public int? Episode { get; set; }
    }
}
