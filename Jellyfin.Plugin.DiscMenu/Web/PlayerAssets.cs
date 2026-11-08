using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.DiscMenu.Web;

/// <summary>
/// The player page's files (web/dist/), embedded in the DLL as <c>web/&lt;file&gt;</c>.
/// </summary>
internal static class PlayerAssets
{
    /// <summary>
    /// The page itself.
    /// </summary>
    public const string Index = "index.html";

    private const string Prefix = "web/";

    private static readonly FrozenDictionary<string, string> _contentTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".txt"] = "text/plain; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".ico"] = "image/x-icon",
    }.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase);

    private static readonly Lazy<FrozenDictionary<string, PlayerAsset>> _assets = new(Load);

    /// <summary>
    /// Gets the names of all embedded files.
    /// </summary>
    public static IEnumerable<string> Names => _assets.Value.Keys;

    /// <summary>
    /// Finds an embedded file by its name in web/dist/.
    /// </summary>
    /// <param name="name">The file name, such as <c>player.js</c>.</param>
    /// <returns>The file, or <c>null</c> when there is none by that name.</returns>
    public static PlayerAsset? Find(string name) => _assets.Value.GetValueOrDefault(name);

    private static FrozenDictionary<string, PlayerAsset> Load()
    {
        var assembly = typeof(PlayerAssets).Assembly;
        var assets = new Dictionary<string, PlayerAsset>(StringComparer.Ordinal);
        foreach (var resource in assembly.GetManifestResourceNames())
        {
            var name = resource.Replace('\\', '/');
            if (!name.StartsWith(Prefix, StringComparison.Ordinal))
            {
                continue;
            }

            using var stream = assembly.GetManifestResourceStream(resource)!;
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);
            var content = buffer.ToArray();
            var tag = new EntityTagHeaderValue("\"" + Convert.ToHexStringLower(SHA256.HashData(content).AsSpan(0, 16)) + "\"");
            var type = _contentTypes.GetValueOrDefault(Path.GetExtension(name), "application/octet-stream");
            assets[name[Prefix.Length..]] = new PlayerAsset(content, type, tag);
        }

        return assets.ToFrozenDictionary(StringComparer.Ordinal);
    }
}
