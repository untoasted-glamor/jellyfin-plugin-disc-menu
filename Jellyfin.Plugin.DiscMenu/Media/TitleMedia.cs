using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.DiscMenu.Media;

/// <summary>
/// One item a pack names and the Jellyfin item that plays it. An item the library lacks has only
/// <see cref="Episode"/>, <see cref="File"/>, <see cref="Season"/> and <see cref="Extra"/>, as the pack gives them.
/// </summary>
/// <param name="Episode">The pack's episode number, for a series episode.</param>
/// <param name="File">The pack's file name.</param>
/// <param name="ItemId">The episode, extra or movie to stream.</param>
/// <param name="Name">The episode, extra or movie's name.</param>
/// <param name="MediaSourceId">The media source (version) to stream.</param>
/// <param name="Streams">The source's audio and subtitle streams, with Jellyfin's indexes.</param>
/// <param name="Season">The pack's season for the episode when it isn't the pack's own (0 for a special).</param>
/// <param name="Extra">The pack's path for an extra, under the show folder.</param>
public sealed record TitleMedia(
    int? Episode,
    string File,
    Guid? ItemId = null,
    string? Name = null,
    string? MediaSourceId = null,
    IReadOnlyList<TitleTrack>? Streams = null,
    int? Season = null,
    string? Extra = null);
