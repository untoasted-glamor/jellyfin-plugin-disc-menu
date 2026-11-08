using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.DiscMenu.Web;

/// <summary>
/// One embedded file of the player page.
/// </summary>
/// <param name="Content">The file's bytes.</param>
/// <param name="ContentType">Its media type.</param>
/// <param name="ETag">A tag from its content, for conditional requests.</param>
internal sealed record PlayerAsset(byte[] Content, string ContentType, EntityTagHeaderValue ETag);
