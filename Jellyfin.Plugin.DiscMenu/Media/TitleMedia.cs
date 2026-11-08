using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.DiscMenu.Media;

/// <summary>
/// One file a pack names and the Jellyfin item that plays it. A file the library lacks has only
/// <see cref="Episode"/> and <see cref="File"/>.
/// </summary>
/// <param name="Episode">The pack's episode number, for a series.</param>
/// <param name="File">The pack's file name.</param>
/// <param name="ItemId">The episode or movie to stream.</param>
/// <param name="Name">The episode or movie's name.</param>
/// <param name="MediaSourceId">The media source (version) to stream.</param>
/// <param name="Streams">The source's audio and subtitle streams, with Jellyfin's indexes.</param>
public sealed record TitleMedia(
    int? Episode,
    string File,
    Guid? ItemId = null,
    string? Name = null,
    string? MediaSourceId = null,
    IReadOnlyList<TitleTrack>? Streams = null);
