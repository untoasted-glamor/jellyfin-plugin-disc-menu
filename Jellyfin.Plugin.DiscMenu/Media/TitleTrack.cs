namespace Jellyfin.Plugin.DiscMenu.Media;

/// <summary>
/// An audio or subtitle stream of a media source.
/// </summary>
/// <param name="Index">Jellyfin's index for the stream, as <c>AudioStreamIndex</c> or <c>SubtitleStreamIndex</c>
/// take it. Indexes are looked up on every request: an added subtitle file can shift them.</param>
/// <param name="Type"><c>Audio</c> or <c>Subtitle</c>.</param>
/// <param name="Language">The stream's language code, as Jellyfin reports it (ISO 639-2/T, such as <c>deu</c>).</param>
/// <param name="IsExternal">Whether the stream is a file next to the video, such as a subtitle file.</param>
/// <param name="FileName">An external stream's file name, without its folder; the player matches a pack's
/// subtitle file by its suffix.</param>
public sealed record TitleTrack(int Index, string Type, string? Language, bool IsExternal, string? FileName = null);
