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
/// Maps the files a pack's title cells name to Jellyfin items and their streams. A series' files are found by the
/// pack's season and each cell's episode number, since file names change after a rip; a movie's by file name among
/// its versions.
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
        return new TitleMedia(title.Episode, title.File, item.Id, item.Name, source.Id, streams);
    }

    // The source whose file has the pack's file name, else the item's first (default) source when allowed.
    private static MediaSourceInfo? PickSource(IReadOnlyList<MediaSourceInfo> sources, string file, bool firstIfNoMatch)
    {
        return sources.FirstOrDefault(s => string.Equals(Path.GetFileName(s.Path), file, StringComparison.OrdinalIgnoreCase))
            ?? (firstIfNoMatch && sources.Count > 0 ? sources[0] : null);
    }

    private List<TitleMedia> MapEpisodes(Series series, PackTitles pack, User? user)
    {
        var episodes = new Dictionary<int, Episode>();
        if (pack.Season is int season && pack.Titles.Any(t => t.Episode is not null))
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
                    episodes.TryAdd(number, episode);
                }
            }
        }

        return pack.Titles.Select(title =>
        {
            if (title.Episode is not int number || !episodes.TryGetValue(number, out var episode))
            {
                return new TitleMedia(title.Episode, title.File);
            }

            // An episode with several versions plays the one with the pack's file name, else its default.
            var source = PickSource(_mediaSourceManager.GetStaticMediaSources(episode, false, user), title.File, firstIfNoMatch: true);
            return source is null ? new TitleMedia(title.Episode, title.File) : Found(title, episode, source);
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
            return source is null ? new TitleMedia(title.Episode, title.File) : Found(title, movie, source);
        }).ToList();
    }
}
