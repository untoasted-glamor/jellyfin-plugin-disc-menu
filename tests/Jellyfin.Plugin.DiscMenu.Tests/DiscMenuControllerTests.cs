using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.DiscMenu.Api;
using Jellyfin.Plugin.DiscMenu.Media;
using Jellyfin.Plugin.DiscMenu.Packs;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace Jellyfin.Plugin.DiscMenu.Tests;

public sealed class DiscMenuControllerTests : IDisposable
{
    private static readonly Guid _movieId = Guid.NewGuid();
    private static readonly Guid _userId = Guid.NewGuid();

    private readonly TempMediaFolder _media = new();
    private readonly ILibraryManager _library = Substitute.For<ILibraryManager>();
    private readonly IUserManager _users = Substitute.For<IUserManager>();
    private readonly IMediaSourceManager _sources = Substitute.For<IMediaSourceManager>();
    private readonly User _alice = new("alice", "auth", "reset");
    private readonly Movie _movie;

    public DiscMenuControllerTests()
    {
        _media.WriteMenu("sintel", """{"disc":{"type":"dvd","name":"Sintel"},"media":{"2:1":{"cells":{"1":{"offset":0,"file":"Movie (2010).mkv"}}}}}""");
        _media.Write("Movie (2010)/.discmenus/sintel/menus/bg.png");
        _movie = new Movie { Id = _movieId, Name = "Movie", Path = Path.Combine(_media.Item, "Movie (2010).mkv") };
        _sources.GetStaticMediaSources(_movie, false, Arg.Any<User>())
            .Returns([new MediaSourceInfo { Id = "source", Path = _movie.Path, MediaStreams = [] }]);
        _users.GetUserById(_userId).Returns(_alice);
        _library.GetItemById<BaseItem>(_movieId, _alice).Returns(_movie);
        _library.GetItemById<BaseItem>(_movieId, (User?)null).Returns(_movie);
    }

    public void Dispose() => _media.Dispose();

    [Fact]
    public void GetPlayer_redirects_to_the_address_with_a_slash_keeping_the_query()
    {
        var controller = Controller(UserPrincipal(), "/DiscMenu/Player", "?item=abc");

        var redirect = Assert.IsType<RedirectResult>(controller.GetPlayer(null));

        Assert.Equal("Player/?item=abc", redirect.Url);
    }

    [Fact]
    public void GetPlayer_serves_the_page_at_the_address_with_a_slash()
    {
        var controller = Controller(new ClaimsPrincipal(), "/DiscMenu/Player/");

        var file = Assert.IsType<FileContentResult>(controller.GetPlayer(null));

        Assert.Equal("text/html; charset=utf-8", file.ContentType);
        Assert.Contains("data-server-root=\"../../\"", Encoding.UTF8.GetString(file.FileContents), StringComparison.Ordinal);
        Assert.NotNull(file.EntityTag);
        Assert.Equal("no-cache", controller.Response.Headers.CacheControl.ToString());
    }

    [Theory]
    [InlineData("player.js", "text/javascript; charset=utf-8")]
    [InlineData("style.css", "text/css; charset=utf-8")]
    [InlineData("index.html", "text/html; charset=utf-8")]
    public void GetPlayer_serves_the_pages_files(string name, string contentType)
    {
        var file = Assert.IsType<FileContentResult>(Controller(new ClaimsPrincipal(), "/DiscMenu/Player/" + name).GetPlayer(name));

        Assert.Equal(contentType, file.ContentType);
        Assert.NotEmpty(file.FileContents);
    }

    [Fact]
    public void GetPlayer_sends_a_strict_policy_that_allows_framing_by_this_server_only()
    {
        var controller = Controller(new ClaimsPrincipal(), "/DiscMenu/Player/");

        controller.GetPlayer(null);

        var policy = controller.Response.Headers.ContentSecurityPolicy.ToString();
        Assert.Contains("script-src 'self';", policy, StringComparison.Ordinal);
        Assert.Contains("frame-ancestors 'self'", policy, StringComparison.Ordinal);
        Assert.Contains("form-action 'none'", policy, StringComparison.Ordinal);
        Assert.DoesNotContain("unsafe", policy, StringComparison.Ordinal);
        Assert.Equal("nosniff", controller.Response.Headers.XContentTypeOptions.ToString());
    }

    [Fact]
    public void GetButtonScript_serves_the_button_with_no_login()
    {
        var controller = Controller(new ClaimsPrincipal(), "/DiscMenu/Inject/button.js");

        var file = Assert.IsType<FileContentResult>(controller.GetButtonScript());

        Assert.Equal("text/javascript; charset=utf-8", file.ContentType);
        Assert.Contains("discmenu:close", Encoding.UTF8.GetString(file.FileContents), StringComparison.Ordinal);
        Assert.Equal("no-cache", controller.Response.Headers.CacheControl.ToString());
        Assert.Equal("nosniff", controller.Response.Headers.XContentTypeOptions.ToString());
        Assert.NotNull(Method(nameof(DiscMenuController.GetButtonScript)).GetCustomAttribute<AllowAnonymousAttribute>());
    }

    [Theory]
    [InlineData("inject/button.js")]
    [InlineData("inject%2Fbutton.js")]
    [InlineData("missing.js")]
    [InlineData("..")]
    [InlineData("../Plugin.cs")]
    [InlineData("web/index.html")]
    public void GetPlayer_404s_on_anything_else(string name)
    {
        Assert.IsType<NotFoundResult>(Controller(new ClaimsPrincipal(), "/DiscMenu/Player/x").GetPlayer(name));
    }

    [Fact]
    public void Only_the_player_page_and_the_button_are_served_without_a_login()
    {
        Assert.NotNull(Method(nameof(DiscMenuController.GetPlayer)).GetCustomAttribute<AllowAnonymousAttribute>());
        Assert.NotNull(Method(nameof(DiscMenuController.GetButtonScript)).GetCustomAttribute<AllowAnonymousAttribute>());
        Assert.NotNull(Method(nameof(DiscMenuController.GetDiscs)).GetCustomAttribute<AuthorizeAttribute>());
        Assert.NotNull(Method(nameof(DiscMenuController.GetFile)).GetCustomAttribute<AuthorizeAttribute>());
        Assert.NotNull(Method(nameof(DiscMenuController.GetMedia)).GetCustomAttribute<AuthorizeAttribute>());
        Assert.Null(typeof(DiscMenuController).GetCustomAttribute<AllowAnonymousAttribute>());
    }

    [Fact]
    public void GetDiscs_lists_the_packs_for_a_user_who_can_see_the_item()
    {
        var result = Controller(UserPrincipal()).GetDiscs(_movieId);

        var ok = Assert.IsType<OkObjectResult>(result.Result);
        Assert.Equal([new DiscInfo("sintel", "Sintel", "dvd", null)], Assert.IsAssignableFrom<IReadOnlyList<DiscInfo>>(ok.Value));
    }

    [Fact]
    public void GetDiscs_lists_the_packs_for_an_api_key()
    {
        var result = Controller(ApiKeyPrincipal()).GetDiscs(_movieId);

        Assert.IsType<OkObjectResult>(result.Result);
        _library.Received().GetItemById<BaseItem>(_movieId, (User?)null);
    }

    [Fact]
    public void GetDiscs_works_on_a_series_folder()
    {
        var seriesId = Guid.NewGuid();
        var series = new Series { Id = seriesId, Path = _media.Item };
        _library.GetItemById<BaseItem>(seriesId, _alice).Returns(series);

        var ok = Assert.IsType<OkObjectResult>(Controller(UserPrincipal()).GetDiscs(seriesId).Result);
        Assert.Single(Assert.IsAssignableFrom<IReadOnlyList<DiscInfo>>(ok.Value));
    }

    [Fact]
    public void GetDiscs_404s_on_an_item_hidden_from_the_user_or_missing()
    {
        var hidden = Guid.NewGuid();

        Assert.IsType<NotFoundResult>(Controller(UserPrincipal()).GetDiscs(hidden).Result);
    }

    [Fact]
    public void GetDiscs_404s_on_an_item_that_is_not_a_series_or_movie()
    {
        var folderId = Guid.NewGuid();
        _library.GetItemById<BaseItem>(folderId, _alice).Returns(new Folder { Id = folderId, Path = _media.Item });

        Assert.IsType<NotFoundResult>(Controller(UserPrincipal()).GetDiscs(folderId).Result);
    }

    [Fact]
    public void GetDiscs_forbids_a_token_with_no_known_user()
    {
        Assert.IsType<ForbidResult>(Controller(UserPrincipal(Guid.NewGuid())).GetDiscs(_movieId).Result);
        Assert.IsType<ForbidResult>(Controller(UserPrincipal(Guid.Empty)).GetDiscs(_movieId).Result);
        Assert.IsType<ForbidResult>(Controller(new ClaimsPrincipal(new ClaimsIdentity())).GetDiscs(_movieId).Result);
        _library.DidNotReceive().GetItemById<BaseItem>(Arg.Any<Guid>(), Arg.Any<User?>());
    }

    [Fact]
    public void GetFile_serves_a_pack_file_with_range_requests()
    {
        var controller = Controller(UserPrincipal());

        var file = Assert.IsType<PhysicalFileResult>(controller.GetFile(_movieId, "sintel", "menus/bg.png"));

        Assert.Equal(Path.Combine(_media.Pack("sintel"), "menus", "bg.png"), file.FileName);
        Assert.Equal("image/png", file.ContentType);
        Assert.True(file.EnableRangeProcessing);
        Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public void GetFile_serves_menu_json_as_json()
    {
        var file = Assert.IsType<PhysicalFileResult>(Controller(UserPrincipal()).GetFile(_movieId, "sintel", "menu.json"));

        Assert.Equal("application/json", file.ContentType);
    }

    [Theory]
    [InlineData("sintel", "../sintel/menu.json")]
    [InlineData("sintel", "/etc/passwd")]
    [InlineData("sintel", "missing.png")]
    [InlineData("sintel", null)]
    [InlineData("..", "Movie (2010).mkv")]
    [InlineData("nodisc", "menu.json")]
    public void GetFile_404s_on_a_bad_path(string disc, string? path)
    {
        Assert.IsType<NotFoundResult>(Controller(UserPrincipal()).GetFile(_movieId, disc, path));
    }

    [Fact]
    public void GetFile_404s_on_a_hidden_item_and_forbids_an_unknown_user()
    {
        Assert.IsType<NotFoundResult>(Controller(UserPrincipal()).GetFile(Guid.NewGuid(), "sintel", "menu.json"));
        Assert.IsType<ForbidResult>(Controller(UserPrincipal(Guid.NewGuid())).GetFile(_movieId, "sintel", "menu.json"));
    }

    [Fact]
    public void GetMedia_maps_the_packs_files_with_the_users_access()
    {
        var controller = Controller(UserPrincipal());

        var ok = Assert.IsType<OkObjectResult>(controller.GetMedia(_movieId, "sintel").Result);

        var media = Assert.IsType<DiscMedia>(ok.Value);
        Assert.Equal("Movie", media.Name);
        var title = Assert.Single(media.Titles);
        Assert.Equal((_movieId, "source"), (title.ItemId, title.MediaSourceId));
        Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());
        _sources.Received().GetStaticMediaSources(_movie, false, _alice);
    }

    [Fact]
    public void GetMedia_for_an_api_key_looks_up_with_no_user()
    {
        Assert.IsType<OkObjectResult>(Controller(ApiKeyPrincipal()).GetMedia(_movieId, "sintel").Result);

        _sources.Received().GetStaticMediaSources(_movie, false, null);
    }

    [Theory]
    [InlineData("nodisc")]
    [InlineData("..")]
    [InlineData("broken")]
    public void GetMedia_404s_on_a_missing_or_unreadable_pack(string disc)
    {
        _media.WriteMenu("broken", "not json");

        Assert.IsType<NotFoundResult>(Controller(UserPrincipal()).GetMedia(_movieId, disc).Result);
    }

    [Fact]
    public void GetMedia_404s_on_a_hidden_item_and_forbids_an_unknown_user()
    {
        Assert.IsType<NotFoundResult>(Controller(UserPrincipal()).GetMedia(Guid.NewGuid(), "sintel").Result);
        Assert.IsType<ForbidResult>(Controller(UserPrincipal(Guid.NewGuid())).GetMedia(_movieId, "sintel").Result);
    }

    private static MethodInfo Method(string name) => typeof(DiscMenuController).GetMethod(name)!;

    private static ClaimsPrincipal UserPrincipal(Guid? userId = null)
    {
        return new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("Jellyfin-UserId", (userId ?? _userId).ToString("N")),
                new Claim("Jellyfin-IsApiKey", "False"),
            ],
            "Test"));
    }

    private static ClaimsPrincipal ApiKeyPrincipal()
    {
        return new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("Jellyfin-UserId", Guid.Empty.ToString("N")),
                new Claim("Jellyfin-IsApiKey", "True"),
            ],
            "Test"));
    }

    private DiscMenuController Controller(ClaimsPrincipal principal, string path = "/", string query = "")
    {
        var context = new DefaultHttpContext { User = principal };
        context.Request.Path = path;
        context.Request.QueryString = new QueryString(query);
        var packs = new PackStore(NullLogger<PackStore>.Instance);
        return new DiscMenuController(_library, _users, packs, new MediaLookup(_library, _sources))
        {
            ControllerContext = new ControllerContext { HttpContext = context },
        };
    }
}
