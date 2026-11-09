using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.DiscMenu.Links;
using Jellyfin.Plugin.DiscMenu.Packs;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace Jellyfin.Plugin.DiscMenu.Tests;

public sealed class DiscMenuLinkProviderTests : IDisposable
{
    private const string MovieMenu = """{"schema":"dvd-1","disc":{"type":"dvd","name":"Sintel"}}""";

    private readonly TempMediaFolder _media = new();
    private readonly IConfigurationManager _config = Substitute.For<IConfigurationManager>();
    private readonly NetworkConfiguration _network = new();
    private readonly ManualTime _time = new();
    private readonly DiscMenuLinkProvider _provider;
    private readonly Movie _movie;

    public DiscMenuLinkProviderTests()
    {
        _config.GetConfiguration(NetworkConfigurationStore.StoreKey).Returns(_network);
        _provider = new DiscMenuLinkProvider(new PackStore(NullLogger<PackStore>.Instance), _config, _time);
        _movie = new Movie { Id = Guid.NewGuid(), Path = Path.Combine(_media.Item, "Movie (2010).mkv") };
    }

    public void Dispose() => _media.Dispose();

    [Fact]
    public void Name_is_the_link_text()
    {
        Assert.Equal("Disc menu", _provider.Name);
    }

    [Fact]
    public void A_movie_with_a_pack_links_to_the_player_page()
    {
        _media.WriteMenu("sintel", MovieMenu);

        var url = Assert.Single(_provider.GetExternalUrls(_movie));

        Assert.Equal("/DiscMenu/Player/?item=" + _movie.Id.ToString("N"), url);
    }

    [Fact]
    public void The_link_is_under_the_base_url()
    {
        _network.BaseUrl = "/jellyfin/";
        _media.WriteMenu("sintel", MovieMenu);

        var url = Assert.Single(_provider.GetExternalUrls(_movie));

        Assert.Equal("/jellyfin/DiscMenu/Player/?item=" + _movie.Id.ToString("N"), url);
    }

    [Fact]
    public void A_series_with_a_pack_links_to_the_player_page()
    {
        _media.WriteMenu("d1", """{"disc":{"type":"dvd","name":"Show D1","season":1}}""");
        var series = new Series { Id = Guid.NewGuid(), Path = _media.Item };

        var url = Assert.Single(_provider.GetExternalUrls(series));

        Assert.Equal("/DiscMenu/Player/?item=" + series.Id.ToString("N"), url);
    }

    [Fact]
    public void One_link_for_several_packs()
    {
        _media.WriteMenu("d1", MovieMenu);
        _media.WriteMenu("d2", MovieMenu);

        Assert.Single(_provider.GetExternalUrls(_movie));
    }

    [Fact]
    public void No_link_without_a_pack()
    {
        Assert.Empty(_provider.GetExternalUrls(_movie));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"disc":{"type":"dvd"}}""")]
    public void No_link_when_the_only_pack_is_broken(string menu)
    {
        _media.WriteMenu("broken", menu);
        Directory.CreateDirectory(_media.Pack("empty"));

        Assert.Empty(_provider.GetExternalUrls(_movie));
    }

    [Fact]
    public void Only_series_and_movies_get_the_link()
    {
        _media.WriteMenu("sintel", MovieMenu);
        var file = Path.Combine(_media.Item, "Movie (2010).mkv");
        BaseItem[] others =
        [
            new Folder { Id = Guid.NewGuid(), Path = _media.Item },
            new Season { Id = Guid.NewGuid(), Path = _media.Item },
            new Episode { Id = Guid.NewGuid(), Path = file },
            new BoxSet { Id = Guid.NewGuid(), Path = _media.Item },
            new Video { Id = Guid.NewGuid(), Path = file },
        ];

        Assert.All(others, item => Assert.Empty(_provider.GetExternalUrls(item)));
    }

    [Fact]
    public void No_link_for_an_item_with_no_folder()
    {
        Assert.Empty(_provider.GetExternalUrls(new Movie { Id = Guid.NewGuid() }));
    }

    [Fact]
    public void A_removed_pack_keeps_its_link_until_the_cache_expires()
    {
        _media.WriteMenu("sintel", MovieMenu);
        Assert.Single(_provider.GetExternalUrls(_movie));

        Directory.Delete(_media.Pack("sintel"), recursive: true);
        _time.Advance(DiscMenuLinkProvider.CacheLifetime - TimeSpan.FromSeconds(1));
        Assert.Single(_provider.GetExternalUrls(_movie));

        _time.Advance(TimeSpan.FromSeconds(1));
        Assert.Empty(_provider.GetExternalUrls(_movie));
    }

    [Fact]
    public void An_added_pack_gets_its_link_once_the_cache_expires()
    {
        Assert.Empty(_provider.GetExternalUrls(_movie));

        _media.WriteMenu("sintel", MovieMenu);
        Assert.Empty(_provider.GetExternalUrls(_movie));

        _time.Advance(DiscMenuLinkProvider.CacheLifetime);
        Assert.Single(_provider.GetExternalUrls(_movie));
    }

    [Fact]
    public void Folders_are_cached_separately()
    {
        _media.WriteMenu("sintel", MovieMenu);
        var other = Path.Combine(_media.Root, "Other (2000)");
        Directory.CreateDirectory(other);
        var otherMovie = new Movie { Id = Guid.NewGuid(), Path = Path.Combine(other, "Other (2000).mkv") };

        Assert.Single(_provider.GetExternalUrls(_movie));
        Assert.Empty(_provider.GetExternalUrls(otherMovie));
    }

    [Fact]
    public void Many_folders_still_answer_after_the_expired_ones_are_dropped()
    {
        _media.WriteMenu("sintel", MovieMenu);
        Assert.Single(_provider.GetExternalUrls(_movie));
        var missing = Enumerable.Range(0, 10_001)
            .Select(i => new Movie { Id = Guid.NewGuid(), Path = Path.Combine(_media.Root, "none-" + i, "x.mkv") })
            .ToList();
        Assert.All(missing, movie => Assert.Empty(_provider.GetExternalUrls(movie)));

        _time.Advance(DiscMenuLinkProvider.CacheLifetime);

        Assert.Empty(_provider.GetExternalUrls(missing[0]));
        Assert.Single(_provider.GetExternalUrls(_movie));
    }

    private sealed class ManualTime : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 11, 8, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }
}
