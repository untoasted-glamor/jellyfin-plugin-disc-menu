using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.DiscMenu.Media;
using Jellyfin.Plugin.DiscMenu.Packs;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using NSubstitute;
using Xunit;

namespace Jellyfin.Plugin.DiscMenu.Tests;

public sealed class MediaLookupTests
{
    private readonly ILibraryManager _library = Substitute.For<ILibraryManager>();
    private readonly IMediaSourceManager _sources = Substitute.For<IMediaSourceManager>();
    private readonly User _alice = new("alice", "auth", "reset");
    private readonly Series _series = new() { Id = Guid.NewGuid(), Name = "Show" };
    private readonly MediaLookup _lookup;

    public MediaLookupTests()
    {
        _lookup = new MediaLookup(_library, _sources);
    }

    [Fact]
    public void Series_episodes_are_found_by_season_and_number_whatever_their_file_names()
    {
        var e1 = Episode(1, "Pilot");
        var e2 = Episode(2, "Second");
        Episodes(e1, e2);
        Sources(e1, Source("/tv/Show/Season 02/Show S02E01 renamed.mkv", Stream(1, MediaStreamType.Audio, "jpn")));
        Sources(e2, Source("/tv/Show/Season 02/Show S02E02.mkv"));

        var media = _lookup.Map(_series, Pack(2, (1, "old name 1.mkv"), (2, "old name 2.mkv")), _alice);

        Assert.Equal("Show", media.Name);
        var first = media.Titles[0];
        Assert.Equal((1, "old name 1.mkv", e1.Id, "Pilot"), (first.Episode, first.File, first.ItemId, first.Name));
        Assert.Equal("src-Show S02E01 renamed.mkv", first.MediaSourceId);
        Assert.Equal([new TitleTrack(1, "Audio", "jpn", false)], first.Streams);
        Assert.Equal(e2.Id, media.Titles[1].ItemId);
    }

    [Fact]
    public void Series_query_asks_for_the_packs_season_with_the_users_access()
    {
        Episodes();

        _lookup.Map(_series, Pack(2, (1, "a.mkv")), _alice);

        _library.Received(1).GetItemList(Arg.Is<InternalItemsQuery>(q =>
            q.AncestorIds.SequenceEqual(new[] { _series.Id })
            && q.IncludeItemTypes.SequenceEqual(new[] { BaseItemKind.Episode })
            && q.ParentIndexNumber == 2
            && q.IsVirtualItem == false
            && q.User == _alice));
    }

    [Fact]
    public void Series_episodes_the_library_lacks_are_listed_without_an_item()
    {
        var e1 = Episode(1, "Pilot");
        Episodes(e1);
        Sources(e1, Source("/tv/e1.mkv"));

        var media = _lookup.Map(_series, Pack(2, (1, "e1.mkv"), (3, "e3.mkv")), _alice);

        Assert.Equal(new TitleMedia(3, "e3.mkv"), media.Titles[1]);
    }

    [Fact]
    public void Series_cell_with_no_episode_number_or_a_pack_with_no_season_finds_nothing()
    {
        var media = _lookup.Map(_series, Pack(null, (1, "e1.mkv")), _alice);
        var noNumber = _lookup.Map(_series, new PackTitles(2, [new PackTitle(null, "e1.mkv")]), _alice);

        Assert.Null(Assert.Single(media.Titles).ItemId);
        Assert.Null(Assert.Single(noNumber.Titles).ItemId);
        _library.DidNotReceive().GetItemList(Arg.Any<InternalItemsQuery>());
    }

    [Fact]
    public void Series_episode_with_versions_plays_the_one_with_the_packs_file_name()
    {
        var e1 = Episode(1, "Pilot");
        Episodes(e1);
        Sources(e1, Source("/tv/Pilot - 720p.mkv"), Source("/tv/Pilot - DVD.mkv"));

        var byName = _lookup.Map(_series, Pack(2, (1, "pilot - dvd.mkv")), _alice);
        var byDefault = _lookup.Map(_series, Pack(2, (1, "Pilot.mkv")), _alice);

        Assert.Equal("src-Pilot - DVD.mkv", byName.Titles[0].MediaSourceId);
        Assert.Equal("src-Pilot - 720p.mkv", byDefault.Titles[0].MediaSourceId);
    }

    [Fact]
    public void Streams_are_audio_and_subtitles_with_an_external_files_name()
    {
        var e1 = Episode(1, "Pilot");
        Episodes(e1);
        Sources(
            e1,
            Source(
                "/tv/e1.mkv",
                Stream(0, MediaStreamType.Video, null),
                Stream(1, MediaStreamType.Audio, "eng"),
                Stream(2, MediaStreamType.Subtitle, "deu"),
                Stream(3, MediaStreamType.Subtitle, "eng", "/tv/e1.en.forced.srt"),
                Stream(4, MediaStreamType.EmbeddedImage, null)));

        var streams = _lookup.Map(_series, Pack(2, (1, "e1.mkv")), _alice).Titles[0].Streams;

        Assert.Equal(
            [
                new TitleTrack(1, "Audio", "eng", false),
                new TitleTrack(2, "Subtitle", "deu", false),
                new TitleTrack(3, "Subtitle", "eng", true, "e1.en.forced.srt"),
            ],
            streams);
    }

    [Fact]
    public void Movie_files_are_found_by_name_among_its_versions()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Sintel" };
        Sources(movie, Source("/movies/Sintel/Sintel (2010).mkv"), Source("/movies/Sintel/Sintel (2010) - Extras.mkv"));

        var media = _lookup.Map(movie, Movie("Sintel (2010) - extras.mkv", "Sintel (2010).mkv", "Outtakes.mkv"), null);

        Assert.Equal("Sintel", media.Name);
        Assert.Equal(
            [null, "src-Sintel (2010) - Extras.mkv", "src-Sintel (2010).mkv"],
            media.Titles.Select(t => t.MediaSourceId));
        Assert.Null(media.Titles[0].ItemId);
        Assert.Equal(movie.Id, media.Titles[1].ItemId);
        _sources.Received().GetStaticMediaSources(movie, false, null);
    }

    [Fact]
    public void Movie_pack_with_one_file_plays_the_film_even_when_it_was_renamed()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Sintel" };
        Sources(movie, Source("/movies/Sintel/Sintel.mkv"));

        var media = _lookup.Map(movie, Movie("Sintel (2010).mkv"), _alice);

        Assert.Equal("src-Sintel.mkv", Assert.Single(media.Titles).MediaSourceId);
    }

    [Fact]
    public void Movie_with_no_media_source_finds_nothing()
    {
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Sintel" };
        Sources(movie);

        Assert.Null(Assert.Single(_lookup.Map(movie, Movie("Sintel (2010).mkv"), _alice).Titles).ItemId);
    }

    [Fact]
    public void Series_special_is_found_in_season_0_beside_the_packs_own_season()
    {
        var e1 = Episode(1, "Pilot", season: 1);
        var s1 = Episode(1, "Special", season: 0);
        EpisodesIn(1, e1);
        EpisodesIn(0, s1);
        Sources(e1, Source("/tv/Show/Season 01/e1.mkv"));
        Sources(s1, Source("/tv/Show/Season 00/s1.mkv"));

        var media = _lookup.Map(
            _series,
            new PackTitles(1, [new PackTitle(1, "e1.mkv"), new PackTitle(1, "s1.mkv", Season: 0)]),
            _alice);

        Assert.Equal((e1.Id, (int?)null), (media.Titles[0].ItemId, media.Titles[0].Season));
        Assert.Equal((s1.Id, (int?)0, "Special"), (media.Titles[1].ItemId, media.Titles[1].Season, media.Titles[1].Name));
        _library.Received(1).GetItemList(Arg.Is<InternalItemsQuery>(q => q.ParentIndexNumber == 0 && q.User == _alice));
        _library.Received(1).GetItemList(Arg.Is<InternalItemsQuery>(q => q.ParentIndexNumber == 1));
    }

    [Fact]
    public void Series_special_in_a_pack_with_no_season_is_still_found()
    {
        var s2 = Episode(2, "Special", season: 0);
        EpisodesIn(0, s2);
        Sources(s2, Source("/tv/Show/Season 00/s2.mkv"));

        var media = _lookup.Map(_series, new PackTitles(null, [new PackTitle(2, "s2.mkv", Season: 0)]), null);

        Assert.Equal(s2.Id, Assert.Single(media.Titles).ItemId);
    }

    [Fact]
    public void Series_extras_are_found_by_file_name_among_the_series_extras()
    {
        var trailer = Extra("/tv/Show/trailers/Trailers.mkv", ExtraType.Trailer);
        var op = Extra("/tv/Show/other/Opening.mkv", ExtraType.Unknown);
        var sameName = Extra("/tv/Show/extras/Opening.mkv", ExtraType.Unknown);
        Extras(trailer, sameName, op);
        Sources(trailer, Source("/tv/Show/trailers/Trailers.mkv", Stream(1, MediaStreamType.Audio, "eng")));
        Sources(op, Source("/tv/Show/other/Opening.mkv"));

        var media = _lookup.Map(
            _series,
            new PackTitles(1, [
                new PackTitle(null, "Trailers.mkv", Extra: "trailers/trailers.MKV"),
                new PackTitle(null, "Opening.mkv", Extra: "other/Opening.mkv"),
            ]),
            _alice);

        var first = media.Titles[0];
        Assert.Equal((trailer.Id, "trailers/trailers.MKV", "src-Trailers.mkv"), (first.ItemId, first.Extra, first.MediaSourceId));
        Assert.Equal([new TitleTrack(1, "Audio", "eng", false)], first.Streams);
        Assert.Equal(op.Id, media.Titles[1].ItemId);
        _library.Received(1).GetItemList(Arg.Is<InternalItemsQuery>(q =>
            q.OwnerIds.SequenceEqual(new[] { _series.Id }) && q.User == _alice));
        _library.DidNotReceive().GetItemList(Arg.Is<InternalItemsQuery>(q => q.ParentIndexNumber != null));
    }

    [Fact]
    public void Series_extra_the_library_lacks_is_listed_without_an_item()
    {
        var notAnExtra = new Video { Id = Guid.NewGuid(), Name = "Owned", Path = "/tv/Show/extras/Gone.mkv" };
        Extras(notAnExtra, Extra("/tv/Show/extras/Other.mkv", ExtraType.Unknown));

        var media = _lookup.Map(
            _series,
            new PackTitles(1, [new PackTitle(null, "Gone.mkv", Extra: "extras/Gone.mkv")]),
            _alice);

        Assert.Equal(new TitleMedia(null, "Gone.mkv", Extra: "extras/Gone.mkv"), Assert.Single(media.Titles));
    }

    [Fact]
    public void Series_special_the_library_lacks_keeps_its_season()
    {
        EpisodesIn(0);

        var media = _lookup.Map(_series, new PackTitles(1, [new PackTitle(4, "s4.mkv", Season: 0)]), _alice);

        Assert.Equal(new TitleMedia(4, "s4.mkv", Season: 0), Assert.Single(media.Titles));
    }

    private static PackTitles Pack(int? season, params (int Episode, string File)[] titles)
    {
        return new PackTitles(season, titles.Select(t => new PackTitle(t.Episode, t.File)).ToList());
    }

    private static PackTitles Movie(params string[] files)
    {
        return new PackTitles(null, files.Order(StringComparer.Ordinal).Select(f => new PackTitle(null, f)).ToList());
    }

    private static Episode Episode(int number, string name, int season = 2)
    {
        return new Episode { Id = Guid.NewGuid(), Name = name, IndexNumber = number, ParentIndexNumber = season };
    }

    private static Video Extra(string path, ExtraType type)
    {
        return new Video { Id = Guid.NewGuid(), Name = System.IO.Path.GetFileNameWithoutExtension(path), Path = path, ExtraType = type };
    }

    private static MediaSourceInfo Source(string path, params MediaStream[] streams)
    {
        return new MediaSourceInfo { Id = "src-" + System.IO.Path.GetFileName(path), Path = path, MediaStreams = streams };
    }

    private static MediaStream Stream(int index, MediaStreamType type, string? language, string? externalPath = null)
    {
        return new MediaStream
        {
            Index = index,
            Type = type,
            Language = language,
            IsExternal = externalPath is not null,
            Path = externalPath,
        };
    }

    private void Episodes(params Episode[] episodes)
    {
        _library.GetItemList(Arg.Is<InternalItemsQuery>(q => q.OwnerIds.Length == 0)).Returns(episodes.Cast<BaseItem>().ToList());
    }

    private void EpisodesIn(int season, params Episode[] episodes)
    {
        _library.GetItemList(Arg.Is<InternalItemsQuery>(q => q.OwnerIds.Length == 0 && q.ParentIndexNumber == season))
            .Returns(episodes.Cast<BaseItem>().ToList());
    }

    private void Extras(params BaseItem[] extras)
    {
        _library.GetItemList(Arg.Is<InternalItemsQuery>(q => q.OwnerIds.Length > 0)).Returns(extras.ToList());
    }

    private void Sources(BaseItem item, params MediaSourceInfo[] sources)
    {
        _sources.GetStaticMediaSources(item, false, Arg.Any<User>()).Returns(sources);
    }
}
