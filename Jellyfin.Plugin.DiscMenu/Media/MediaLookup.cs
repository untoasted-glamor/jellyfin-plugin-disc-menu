using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.DiscMenu.Packs;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.DiscMenu.Media;

/// <summary>
/// Maps the items a pack's title cells name to Jellyfin items and their streams. A series' episodes are found by
/// season (the cell's, else the pack's) and episode number, since file names change after a rip; its extras by file
/// name among the series' extras; a movie's files by file name among its versions.
/// </summary>
public sealed class MediaLookup
{
    private readonly ILibraryManager _libraryManager;
    private readonly IMediaSourceManager _mediaSourceManager;

    /// <summary>
    /// Initializes a new instance of the <see cref="MediaLookup"/> class.
    /// </summary>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="mediaSourceManager">The media source manager.</param>
    public MediaLookup(ILibraryManager libraryManager, IMediaSourceManager mediaSourceManager)
    {
        _libraryManager = libraryManager;
        _mediaSourceManager = mediaSourceManager;
    }

    /// <summary>
    /// Finds the item, media source and streams for each file a pack names.
    /// </summary>
    /// <param name="item">The series or movie the pack belongs to, already checked to be visible to the user.</param>
    /// <param name="pack">The pack's season and files.</param>
    /// <param name="user">The user, whose access limits the episodes and versions found; <c>null</c> for an API
    /// key, which sees everything.</param>
    /// <returns>Each file of the pack, with what plays it when the library has it.</returns>
    public DiscMedia Map(BaseItem item, PackTitles pack, User? user)
    {
        ArgumentNullException.ThrowIfNull(item);
        ArgumentNullException.ThrowIfNull(pack);
        var titles = item is Series series ? MapEpisodes(series, pack, user) : MapMovie(item, pack, user);
        return new DiscMedia(item.Name, titles);
    }

    private static TitleMedia Found(PackTitle title, BaseItem item, MediaSourceInfo source)
    {
        var streams = source.MediaStreams
            .Where(s => s.Type is MediaStreamType.Audio or MediaStreamType.Subtitle)
            .Select(s => new TitleTrack(
                s.Index,
                s.Type.ToString(),
                s.Language,
                s.IsExternal,
                s.IsExternal && !string.IsNullOrEmpty(s.Path) ? Path.GetFileName(s.Path) : null))
            .ToList();
        return new TitleMedia(title.Episode, title.File, item.Id, item.Name, source.Id, streams, title.Season, title.Extra);
    }

    private static TitleMedia Missing(PackTitle title) => new(title.Episode, title.File, Season: title.Season, Extra: title.Extra);

    // The extra with the pack's file name; when several have it (in different folders), the one in the pack's folder.
    private static BaseItem? PickExtra(IReadOnlyList<BaseItem> extras, PackTitle title)
    {
        var named = extras
            .Where(e => string.Equals(Path.GetFileName(e.Path), title.ExtraFileName, StringComparison.OrdinalIgnoreCase))
            .ToList();
        var folder = Path.GetDirectoryName(title.Extra!.Replace('\\', '/'));
        return named.FirstOrDefault(e => !string.IsNullOrEmpty(folder)
                && string.Equals(Path.GetFileName(Path.GetDirectoryName(e.Path)), Path.GetFileName(folder), StringComparison.OrdinalIgnoreCase))
            ?? named.FirstOrDefault();
    }

    // The source whose file has the pack's file name, else the item's first (default) source when allowed.
    private static MediaSourceInfo? PickSource(IReadOnlyList<MediaSourceInfo> sources, string file, bool firstIfNoMatch)
    {
        return sources.FirstOrDefault(s => string.Equals(Path.GetFileName(s.Path), file, StringComparison.OrdinalIgnoreCase))
            ?? (firstIfNoMatch && sources.Count > 0 ? sources[0] : null);
    }

    private List<TitleMedia> MapEpisodes(Series series, PackTitles pack, User? user)
    {
        // One query per season the pack names: its own, plus any its cells give (season 0 for specials).
        var episodes = new Dictionary<(int Season, int Number), Episode>();
        var seasons = pack.Titles
            .Where(t => t.Extra is null && t.Episode is not null)
            .Select(t => t.Season ?? pack.Season)
            .OfType<int>()
            .Distinct()
            .Order();
        foreach (var season in seasons)
        {
            var query = new InternalItemsQuery(user)
            {
                AncestorIds = [series.Id],
                IncludeItemTypes = [BaseItemKind.Episode],
                ParentIndexNumber = season,
                IsVirtualItem = false,
                Recursive = true,
            };
            foreach (var episode in _libraryManager.GetItemList(query).OfType<Episode>())
            {
                if (episode.IndexNumber is int number)
                {
                    episodes.TryAdd((season, number), episode);
                }
            }
        }

        // The series' extras, as BaseItem.GetExtras lists them (items owned by the series), with the user's access.
        IReadOnlyList<BaseItem> extras = [];
        if (pack.Titles.Any(t => t.Extra is not null))
        {
            extras = _libraryManager.GetItemList(new InternalItemsQuery(user) { OwnerIds = [series.Id] })
                .Where(e => e.ExtraType is not null)
                .ToList();
        }

        return pack.Titles.Select(title =>
        {
            BaseItem? item = null;
            if (title.Extra is not null)
            {
                item = PickExtra(extras, title);
            }
            else if (title.Episode is int number && (title.Season ?? pack.Season) is int season
                && episodes.TryGetValue((season, number), out var episode))
            {
                item = episode;
            }

            if (item is null)
            {
                return Missing(title);
            }

            // An item with several versions plays the one with the pack's file name, else its default.
            var source = PickSource(_mediaSourceManager.GetStaticMediaSources(item, false, user), title.File, firstIfNoMatch: true);
            return source is null ? Missing(title) : Found(title, item, source);
        }).ToList();
    }

    private List<TitleMedia> MapMovie(BaseItem movie, PackTitles pack, User? user)
    {
        var sources = _mediaSourceManager.GetStaticMediaSources(movie, false, user);

        // A pack that plays one file is the film itself, even when the file was renamed after the rip.
        var single = pack.Titles.Count == 1;
        return pack.Titles.Select(title =>
        {
            var source = PickSource(sources, title.File, firstIfNoMatch: single);
            return source is null ? Missing(title) : Found(title, movie, source);
        }).ToList();
    }
}
