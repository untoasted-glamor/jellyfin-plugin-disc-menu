using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.DiscMenu.Packs;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.DiscMenu.Tests;

public sealed class PackStoreTests : IDisposable
{
    private const string MovieMenu = """{"schema":"dvd-1","disc":{"type":"dvd","name":"Sintel"},"vmg":{}}""";

    private readonly TempMediaFolder _media = new();
    private readonly PackStore _store = new(NullLogger<PackStore>.Instance);

    public PackStoreTests()
    {
        _media.WriteMenu("sintel", MovieMenu);
        _media.Write("Movie (2010)/.discmenus/sintel/menus/bg.png");
    }

    public void Dispose() => _media.Dispose();

    [Theory]
    [InlineData("menu.json")]
    [InlineData("menus/bg.png")]
    public void ResolveFile_finds_a_file_in_the_pack(string path)
    {
        var file = _store.ResolveFile(_media.Item, "sintel", path);

        Assert.Equal(Path.Combine(_media.Pack("sintel"), path), file);
    }

    [Theory]
    [InlineData("../sintel/menu.json")]
    [InlineData("menus/../menu.json")]
    [InlineData("menus/../../sintel/menu.json")]
    [InlineData("./menu.json")]
    [InlineData("..")]
    [InlineData("/etc/passwd")]
    [InlineData("menus//bg.png")]
    [InlineData("menus/")]
    [InlineData("..\\sintel\\menu.json")]
    [InlineData("menus\\bg.png")]
    [InlineData("..%2Fsintel%2Fmenu.json")]
    [InlineData("menus%2Fbg.png")]
    [InlineData("%2e%2e/menu.json")]
    [InlineData("C:menu.json")]
    [InlineData("menu.json\0.png")]
    [InlineData(".hidden")]
    [InlineData("")]
    [InlineData(null)]
    public void ResolveFile_refuses_paths_that_could_leave_the_pack(string? path)
    {
        Assert.Null(_store.ResolveFile(_media.Item, "sintel", path));
    }

    [Theory]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData(".discmenus")]
    [InlineData("a/b")]
    [InlineData("..\\sintel")]
    [InlineData("%2e%2e")]
    [InlineData("")]
    public void ResolveFile_refuses_unsafe_disc_names(string disc)
    {
        Assert.Null(_store.ResolveFile(_media.Item, disc, "menu.json"));
    }

    [Fact]
    public void ResolveFile_refuses_a_folder_or_a_missing_file()
    {
        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "menus"));
        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "missing.png"));
        Assert.Null(_store.ResolveFile(_media.Item, "nodisc", "menu.json"));
    }

    [Fact]
    public void ResolveFile_refuses_a_file_link_out_of_the_pack()
    {
        var outside = _media.Write("Movie (2010)/Movie (2010).mkv");
        File.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "movie.mkv"), outside);
        File.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "relative.mkv"), "../../Movie (2010).mkv");

        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "movie.mkv"));
        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "relative.mkv"));
    }

    [Fact]
    public void ResolveFile_refuses_a_folder_link_out_of_the_pack()
    {
        _media.Write("secret/passwd");
        _media.WriteMenu("other", MovieMenu);
        Directory.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "up"), "..");
        Directory.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "out"), Path.Combine(_media.Root, "secret"));

        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "up/other/menu.json"));
        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "out/passwd"));

        // Out and back in again is still inside the pack.
        Assert.Equal(
            Path.Combine(_media.Pack("sintel"), "menu.json"),
            _store.ResolveFile(_media.Item, "sintel", "up/sintel/menu.json"));
    }

    [Fact]
    public void ResolveFile_refuses_a_link_that_reaches_a_sibling_with_the_same_prefix()
    {
        _media.Write("Movie (2010)/.discmenus/sintel-other/menu.json");
        File.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "other.json"), "../sintel-other/menu.json");

        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "other.json"));
    }

    [Fact]
    public void ResolveFile_refuses_a_link_loop()
    {
        File.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "a"), "b");
        File.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "b"), "a");

        Assert.Null(_store.ResolveFile(_media.Item, "sintel", "a"));
    }

    [Fact]
    public void ResolveFile_follows_a_link_that_stays_in_the_pack()
    {
        File.CreateSymbolicLink(Path.Combine(_media.Pack("sintel"), "again.json"), "menus/../menu.json");

        Assert.Equal(Path.Combine(_media.Pack("sintel"), "menu.json"), _store.ResolveFile(_media.Item, "sintel", "again.json"));
    }

    [Fact]
    public void ResolveFile_serves_a_pack_whose_folder_is_a_link()
    {
        var elsewhere = Path.Combine(_media.Root, "packs", "linked");
        _media.Write("packs/linked/menu.json", MovieMenu);
        Directory.CreateSymbolicLink(_media.Pack("linked"), elsewhere);

        Assert.Equal(Path.Combine(elsewhere, "menu.json"), _store.ResolveFile(_media.Item, "linked", "menu.json"));
        Assert.Null(_store.ResolveFile(_media.Item, "linked", "../sintel/menu.json"));
    }

    [Fact]
    public void ListDiscs_reads_each_packs_name_format_and_season()
    {
        _media.WriteMenu("b-series", """{"disc":{"type":"bluray","name":"Show","season":2}}""");

        var discs = _store.ListDiscs(_media.Item);

        Assert.Equal(
            [new DiscInfo("b-series", "Show", "bluray", 2), new DiscInfo("sintel", "Sintel", "dvd", null)],
            discs);
    }

    [Fact]
    public void ListDiscs_is_empty_without_a_packs_folder()
    {
        Directory.Delete(Path.Combine(_media.Item, ".discmenus"), recursive: true);

        Assert.Empty(_store.ListDiscs(_media.Item));
        Assert.Empty(_store.ListDiscs(Path.Combine(_media.Root, "no such folder")));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"disc":{"type":"dvd"}}""")]
    [InlineData("""{"disc":{"name":"No format"}}""")]
    [InlineData("""{"disc":{"type":"dvd","name":""}}""")]
    [InlineData("""{"disc":{"type":"dvd","name":"Bad season","season":"one"}}""")]
    [InlineData("""{"schema":"dvd-1"}""")]
    [InlineData("[]")]
    public void ListDiscs_leaves_out_a_pack_it_cant_read(string json)
    {
        _media.WriteMenu("broken", json);

        Assert.Equal(["sintel"], Ids(_store.ListDiscs(_media.Item)));
    }

    [Fact]
    public void ListDiscs_leaves_out_a_folder_without_menu_json_and_hidden_folders()
    {
        Directory.CreateDirectory(_media.Pack("empty"));
        _media.WriteMenu(".hidden", MovieMenu);

        Assert.Equal(["sintel"], Ids(_store.ListDiscs(_media.Item)));
    }

    [Fact]
    public void ListDiscs_leaves_out_a_pack_whose_menu_json_links_out()
    {
        var outside = _media.Write("elsewhere/menu.json", MovieMenu);
        Directory.CreateDirectory(_media.Pack("escape"));
        File.CreateSymbolicLink(Path.Combine(_media.Pack("escape"), "menu.json"), outside);

        Assert.Equal(["sintel"], Ids(_store.ListDiscs(_media.Item)));
    }

    [Fact]
    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    public void ListDiscs_leaves_out_an_unreadable_menu_json()
    {
        Assert.SkipWhen(Environment.UserName == "root", "root can read any file");
        var menu = _media.WriteMenu("locked", MovieMenu);
        File.SetUnixFileMode(menu, UnixFileMode.None);

        Assert.Equal(["sintel"], Ids(_store.ListDiscs(_media.Item)));
    }

    [Fact]
    public void ReadTitles_lists_a_movies_files_once_each()
    {
        _media.WriteMenu("film", """
            {"disc":{"type":"dvd","name":"Film"},"media":{
              "2:1":{"cells":{"1":{"offset":0,"file":"Film.mkv"},"2":{"offset":90.5,"file":"Film.mkv"}}},
              "3:1":{"cells":{"1":{"offset":0,"file":"Extras.mkv"},"2":{"offset":0}}}}}
            """);

        var titles = _store.ReadTitles(_media.Item, "film");

        Assert.NotNull(titles);
        Assert.Null(titles.Season);
        Assert.Equal([new PackTitle(null, "Extras.mkv"), new PackTitle(null, "Film.mkv")], titles.Titles);
    }

    [Fact]
    public void ReadTitles_lists_a_series_episodes_in_number_order()
    {
        _media.WriteMenu("d1", """
            {"disc":{"type":"dvd","name":"Show","season":2},"media":{
              "1:1":{"cells":{"1":{"offset":0,"file":"b.mkv","episode":10},"2":{"offset":0,"file":"a.mkv","episode":9}}},
              "1:2":{"cells":{"1":{"offset":12,"file":"b.mkv","episode":10},"2":{"offset":0,"file":"menu-extra.mkv"}}}}}
            """);

        var titles = _store.ReadTitles(_media.Item, "d1");

        Assert.NotNull(titles);
        Assert.Equal(2, titles.Season);
        Assert.Equal(
            [new PackTitle(9, "a.mkv"), new PackTitle(10, "b.mkv"), new PackTitle(null, "menu-extra.mkv")],
            titles.Titles);
    }

    [Fact]
    public void ReadTitles_lists_specials_and_extras_after_the_packs_own_episodes()
    {
        _media.WriteMenu("bd2", """
            {"schema":"hdmv-1","disc":{"type":"bd","name":"Show","season":1},"media":{
              "00008":{"cells":{"0":{"offset":0,"dur":1440,"file":"e10.mkv","episode":10},
                                "64800000":{"offset":0,"dur":1440,"file":"e11.mkv","episode":11}}},
              "00009":{"cells":{"0":{"offset":0,"dur":1440,"file":"e10.mkv","episode":10}}},
              "00022":{"cells":{"0":{"offset":0,"dur":314,"file":"s1.mkv","season":0,"episode":1},
                                "14130000":{"offset":0,"dur":377,"file":"s2.mkv","season":0,"episode":2}}},
              "00023":{"cells":{"0":{"offset":0,"file":"s1.mkv","season":0,"episode":1}}},
              "00021":{"cells":{"0":{"offset":0,"file":"Trailers.mkv","extra":"trailers/Trailers.mkv"}}},
              "00029":{"cells":{"0":{"offset":0,"extra":"other/Opening.mkv"}}},
              "00030":{"cells":{"0":{"offset":0,"file":"loose.mkv","season":0}}}}}
            """);

        var titles = _store.ReadTitles(_media.Item, "bd2");

        Assert.NotNull(titles);
        Assert.Equal(
            [
                new PackTitle(10, "e10.mkv"),
                new PackTitle(11, "e11.mkv"),
                new PackTitle(1, "s1.mkv", 0),
                new PackTitle(2, "s2.mkv", 0),
                new PackTitle(null, "Opening.mkv", Extra: "other/Opening.mkv"),
                new PackTitle(null, "Trailers.mkv", Extra: "trailers/Trailers.mkv"),
                new PackTitle(null, "loose.mkv"),
            ],
            titles.Titles);
        Assert.Equal(
            ["E10", "E11", "S0E1", "S0E2", "X:other/Opening.mkv", "X:trailers/Trailers.mkv", "F:loose.mkv"],
            titles.Titles.Select(t => t.Key));
    }

    [Fact]
    public void ReadTitles_keeps_an_episode_in_the_packs_season_apart_from_the_same_number_in_season_0()
    {
        _media.WriteMenu("d1", """
            {"disc":{"type":"dvd","name":"Show","season":1},"media":{
              "1:1":{"cells":{"1":{"offset":0,"file":"e1.mkv","episode":1},"2":{"offset":0,"file":"sp1.mkv","season":0,"episode":1}}}}}
            """);

        var titles = _store.ReadTitles(_media.Item, "d1");

        Assert.Equal([new PackTitle(1, "e1.mkv"), new PackTitle(1, "sp1.mkv", 0)], titles!.Titles);
    }

    [Fact]
    public void ReadTitles_is_empty_for_a_pack_with_no_media()
    {
        var titles = _store.ReadTitles(_media.Item, "sintel");

        Assert.NotNull(titles);
        Assert.Empty(titles.Titles);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"media":{"1:1":{"cells":{"1":{"file":"a.mkv","episode":"one"}}}}}""")]
    [InlineData("""{"media":[]}""")]
    public void ReadTitles_is_null_for_a_menu_json_it_cant_read(string json)
    {
        _media.WriteMenu("broken", json);

        Assert.Null(_store.ReadTitles(_media.Item, "broken"));
    }

    [Theory]
    [InlineData("nodisc")]
    [InlineData("..")]
    [InlineData(".discmenus")]
    public void ReadTitles_is_null_for_a_missing_or_unsafe_pack(string disc)
    {
        Assert.Null(_store.ReadTitles(_media.Item, disc));
    }

    [Theory]
    [InlineData("sintel", true)]
    [InlineData("VTSM01.en.pgc10.c1.b01.selected.png", true)]
    [InlineData("disc 1", true)]
    [InlineData(".", false)]
    [InlineData("..", false)]
    [InlineData(".x", false)]
    [InlineData("a/b", false)]
    [InlineData("a\\b", false)]
    [InlineData("a:b", false)]
    [InlineData("a%2fb", false)]
    [InlineData("a\tb", false)]
    [InlineData("", false)]
    public void IsSafeName(string name, bool safe)
    {
        Assert.Equal(safe, PackStore.IsSafeName(name));
    }

    [Fact]
    public void IsSafeName_refuses_names_longer_than_255()
    {
        Assert.True(PackStore.IsSafeName(new string('a', 255)));
        Assert.False(PackStore.IsSafeName(new string('a', 256)));
    }

    private static string[] Ids(System.Collections.Generic.IReadOnlyList<DiscInfo> discs)
    {
        return Array.ConvertAll([.. discs], d => d.Id);
    }
}
