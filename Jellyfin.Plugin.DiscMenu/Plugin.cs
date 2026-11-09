using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.DiscMenu.Configuration;
using Jellyfin.Plugin.DiscMenu.Web;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.DiscMenu;

/// <summary>
/// Plays a disc's own title screen and menus inside Jellyfin.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <inheritdoc />
    public override string Name => "Disc Menu";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("bea19561-f7f9-44d6-a4d2-c46b41d04a94");

    /// <inheritdoc />
    public override string Description => "Plays a disc's own title screen and menus inside Jellyfin.";

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Removes the Disc menu button from JavaScript Injector's settings, so it doesn't outlive the plugin.
    /// </summary>
    public override void OnUninstalling()
    {
        try
        {
            JavaScriptInjector.Unregister(JavaScriptInjector.FindInterface());
        }
        catch (Exception ex) when (JavaScriptInjector.IsInjectorFailure(ex))
        {
            // Injector is optional; its leftover entry only loads a script that is gone (a 404, and no button).
        }

        base.OnUninstalling();
    }

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = string.Format(CultureInfo.InvariantCulture, "{0}.Configuration.configPage.html", GetType().Namespace)
            }
        ];
    }
}
