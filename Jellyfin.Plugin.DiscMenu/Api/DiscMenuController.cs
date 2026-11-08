using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.DiscMenu.Media;
using Jellyfin.Plugin.DiscMenu.Packs;
using Jellyfin.Plugin.DiscMenu.Web;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.StaticFiles;

namespace Jellyfin.Plugin.DiscMenu.Api;

/// <summary>
/// The player page, and the menu packs next to a series or movie.
/// </summary>
[ApiController]
[Route("DiscMenu")]
public class DiscMenuController : ControllerBase
{
    // Claim names set by Jellyfin's authentication handler (Jellyfin.Api's InternalClaimTypes, not in a package).
    private const string UserIdClaim = "Jellyfin-UserId";
    private const string IsApiKeyClaim = "Jellyfin-IsApiKey";

    private static readonly FileExtensionContentTypeProvider _contentTypes = new();

    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly PackStore _packs;
    private readonly MediaLookup _media;

    /// <summary>
    /// Initializes a new instance of the <see cref="DiscMenuController"/> class.
    /// </summary>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="userManager">The user manager.</param>
    /// <param name="packs">The menu pack store.</param>
    /// <param name="media">The lookup from a pack's files to library items.</param>
    public DiscMenuController(ILibraryManager libraryManager, IUserManager userManager, PackStore packs, MediaLookup media)
    {
        _libraryManager = libraryManager;
        _userManager = userManager;
        _packs = packs;
        _media = media;
    }

    /// <summary>
    /// Serves the player page and its scripts and styles. These are the only routes that need no login: a page
    /// load can't carry a token, so the page signs in and sends its token on every later call.
    /// </summary>
    /// <param name="file">The file; the page itself when empty.</param>
    /// <response code="200">The file.</response>
    /// <response code="302">The page's address without its trailing slash: redirects to it with the slash.</response>
    /// <response code="404">No such file.</response>
    /// <returns>The page or one of its files, or a redirect.</returns>
    [HttpGet("Player")]
    [HttpGet("Player/{file}")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status302Found)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetPlayer([FromRoute] string? file)
    {
        if (string.IsNullOrEmpty(file))
        {
            // The page's own addresses are relative, so it must load from .../Player/, not .../Player.
            if (!(Request.Path.Value ?? string.Empty).EndsWith('/'))
            {
                return Redirect("Player/" + Request.QueryString);
            }

            file = PlayerAssets.Index;
        }

        var asset = PlayerAssets.Find(file);
        if (asset is null)
        {
            return NotFound();
        }

        // Always revalidate: names don't change between releases, the ETag does.
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.XContentTypeOptions = "nosniff";
        return File(asset.Content, asset.ContentType, lastModified: null, entityTag: asset.ETag);
    }

    /// <summary>
    /// Lists the menu packs of a series or movie.
    /// </summary>
    /// <param name="itemId">The series or movie.</param>
    /// <response code="200">The packs, possibly none.</response>
    /// <response code="403">The token belongs to no known user.</response>
    /// <response code="404">No series or movie by that id that this user can see.</response>
    /// <returns>The packs.</returns>
    [HttpGet("Items/{itemId}/Discs")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<IReadOnlyList<DiscInfo>> GetDiscs([FromRoute, Required] Guid itemId)
    {
        var lookup = FindItem(itemId);
        if (lookup.Result is not null)
        {
            return lookup.Result;
        }

        return Ok(_packs.ListDiscs(lookup.Item!.ContainingFolderPath));
    }

    /// <summary>
    /// Serves one file of a menu pack: its <c>menu.json</c>, or a menu image or video, with range requests.
    /// </summary>
    /// <param name="itemId">The series or movie.</param>
    /// <param name="disc">The pack's folder name.</param>
    /// <param name="path">The file's path inside the pack.</param>
    /// <response code="200">The file.</response>
    /// <response code="403">The token belongs to no known user.</response>
    /// <response code="404">No such item, pack or file, or a path that leads out of the pack.</response>
    /// <returns>The pack's file, whole or the range asked for.</returns>
    [HttpGet("Items/{itemId}/Discs/{disc}/Files/{**path}")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status206PartialContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetFile([FromRoute, Required] Guid itemId, [FromRoute, Required] string disc, [FromRoute] string? path)
    {
        var lookup = FindItem(itemId);
        if (lookup.Result is not null)
        {
            return lookup.Result;
        }

        var file = _packs.ResolveFile(lookup.Item!.ContainingFolderPath, disc, path);
        if (file is null)
        {
            return NotFound();
        }

        if (!_contentTypes.TryGetContentType(file, out var contentType))
        {
            contentType = "application/octet-stream";
        }

        Response.Headers.CacheControl = "private, no-cache";
        Response.Headers.XContentTypeOptions = "nosniff";
        return PhysicalFile(file, contentType, enableRangeProcessing: true);
    }

    /// <summary>
    /// Maps each file a pack's title cells play to the Jellyfin item, media source and streams that play it: for a
    /// series by the pack's season and the episode number, for a movie by file name among its versions.
    /// </summary>
    /// <param name="itemId">The series or movie.</param>
    /// <param name="disc">The pack's folder name.</param>
    /// <response code="200">Each file the pack names; one the library lacks has no <c>ItemId</c>.</response>
    /// <response code="403">The token belongs to no known user.</response>
    /// <response code="404">No such item or pack, or the pack's <c>menu.json</c> can't be read.</response>
    /// <returns>The pack's files and what plays them.</returns>
    [HttpGet("Items/{itemId}/Discs/{disc}/Media")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<DiscMedia> GetMedia([FromRoute, Required] Guid itemId, [FromRoute, Required] string disc)
    {
        var lookup = FindItem(itemId);
        if (lookup.Result is not null)
        {
            return lookup.Result;
        }

        var titles = _packs.ReadTitles(lookup.Item!.ContainingFolderPath, disc);
        if (titles is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "private, no-cache";
        return Ok(_media.Map(lookup.Item, titles, lookup.User));
    }

    // A series or movie the caller may see, and the caller's user (null for an API key). An API key sees every item,
    // as it does in Jellyfin's own API; a user's token sees what that user can see. A hidden item is reported as
    // missing, so its id leaks nothing.
    private (BaseItem? Item, User? User, ActionResult? Result) FindItem(Guid itemId)
    {
        User? user = null;
        if (!IsApiKey(User))
        {
            var userId = GetUserId(User);
            user = userId is null ? null : _userManager.GetUserById(userId.Value);
            if (user is null)
            {
                return (null, null, Forbid());
            }
        }

        var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
        if (item is not (Movie or Series) || string.IsNullOrEmpty(item.ContainingFolderPath))
        {
            return (null, null, NotFound());
        }

        return (item, user, null);
    }

    private static bool IsApiKey(ClaimsPrincipal principal)
    {
        return bool.TryParse(principal.FindFirst(IsApiKeyClaim)?.Value, out var isApiKey) && isApiKey;
    }

    private static Guid? GetUserId(ClaimsPrincipal principal)
    {
        var value = principal.FindFirst(UserIdClaim)?.Value;
        return Guid.TryParse(value, CultureInfo.InvariantCulture, out var id) && id != Guid.Empty ? id : null;
    }
}
