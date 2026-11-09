using System;
using System.IO;

namespace Jellyfin.Plugin.DiscMenu.Tests;

/// <summary>
/// A throwaway folder laid out like a movie folder, deleted when disposed.
/// </summary>
public sealed class TempMediaFolder : IDisposable
{
    public TempMediaFolder()
    {
        Root = Path.Combine(Path.GetTempPath(), "discmenu-tests-" + Guid.NewGuid().ToString("N"));
        Item = Path.Combine(Root, "Movie (2010)");
        Directory.CreateDirectory(Item);
    }

    /// <summary>Gets a folder above the item, for files that sit outside it.</summary>
    public string Root { get; }

    /// <summary>Gets the movie folder.</summary>
    public string Item { get; }

    /// <summary>Gets the path of a pack's folder.</summary>
    /// <param name="disc">The pack's folder name.</param>
    /// <returns>The path.</returns>
    public string Pack(string disc) => Path.Combine(Item, ".discmenus", disc);

    /// <summary>Writes a file under the root, creating its folders.</summary>
    /// <param name="relative">Its path under the root.</param>
    /// <param name="content">Its content.</param>
    /// <returns>Its full path.</returns>
    public string Write(string relative, string content = "x")
    {
        var path = Path.Combine(Root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    /// <summary>Writes a pack's menu.json.</summary>
    /// <param name="disc">The pack's folder name.</param>
    /// <param name="json">The file's content.</param>
    /// <returns>Its full path.</returns>
    public string WriteMenu(string disc, string json)
    {
        Directory.CreateDirectory(Pack(disc));
        var path = Path.Combine(Pack(disc), "menu.json");
        File.WriteAllText(path, json);
        return path;
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
