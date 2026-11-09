using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.DiscMenu.Packs;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Providers;

namespace Jellyfin.Plugin.DiscMenu.Links;

/// <summary>
/// Adds a "Disc menu" entry to the Links of a series or movie that has a menu pack, pointing at the player page.
/// Jellyfin asks every link provider about every item it returns with its links, so whether a folder has packs is
/// cached for <see cref="CacheLifetime"/>: a pack added or removed shows in the links within that time.
/// </summary>
public sealed class DiscMenuLinkProvider : IExternalUrlProvider
{
    /// <summary>
    /// How long the answer for one folder is kept.
    /// </summary>
    internal static readonly TimeSpan CacheLifetime = TimeSpan.FromMinutes(1);

    // Above this many cached folders, a lookup that misses first drops the expired ones.
    private const int SweepAbove = 10_000;

    private readonly PackStore _packs;
    private readonly IConfigurationManager _config;
    private readonly TimeProvider _time;
    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);

    /// <summary>
    /// Initializes a new instance of the <see cref="DiscMenuLinkProvider"/> class.
    /// </summary>
    /// <param name="packs">The menu pack store.</param>
    /// <param name="config">The server configuration, for its base URL.</param>
    public DiscMenuLinkProvider(PackStore packs, IConfigurationManager config)
        : this(packs, config, TimeProvider.System)
    {
    }

    internal DiscMenuLinkProvider(PackStore packs, IConfigurationManager config, TimeProvider time)
    {
        _packs = packs;
        _config = config;
        _time = time;
    }

    /// <inheritdoc />
    public string Name => "Disc menu";

    /// <summary>
    /// Gets the player page's address for an item, from the server's root and under its base URL.
    /// </summary>
    /// <param name="baseUrl">The server's base URL: empty, or <c>/name</c> with no trailing slash.</param>
    /// <param name="itemId">The series or movie.</param>
    /// <returns>The address, such as <c>/jellyfin/DiscMenu/Player/?item=...</c>.</returns>
    internal static string PlayerUrl(string baseUrl, Guid itemId)
    {
        return baseUrl + "/DiscMenu/Player/?item=" + itemId.ToString("N", CultureInfo.InvariantCulture);
    }

    /// <inheritdoc />
    public IEnumerable<string> GetExternalUrls(BaseItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        // Only series and movies have packs (see the controller), so no other item touches the disk.
        if (item is not (Movie or Series) || string.IsNullOrEmpty(item.ContainingFolderPath))
        {
            return [];
        }

        if (!HasPacks(item.ContainingFolderPath))
        {
            return [];
        }

        // Relative to the server's root, not absolute: the server can't know the address a viewer reached it at
        // (a reverse proxy may change the scheme and host), and the page must share the web client's origin.
        return [PlayerUrl(_config.GetNetworkConfiguration().BaseUrl, item.Id)];
    }

    private bool HasPacks(string folder)
    {
        var now = _time.GetUtcNow();
        if (_cache.TryGetValue(folder, out var entry) && entry.Expires > now)
        {
            return entry.HasPacks;
        }

        if (_cache.Count > SweepAbove)
        {
            foreach (var (key, value) in _cache)
            {
                if (value.Expires <= now)
                {
                    _cache.TryRemove(key, out _);
                }
            }
        }

        var hasPacks = _packs.ListDiscs(folder).Count > 0;
        _cache[folder] = new CacheEntry(hasPacks, now + CacheLifetime);
        return hasPacks;
    }

    private readonly record struct CacheEntry(bool HasPacks, DateTimeOffset Expires);
}
