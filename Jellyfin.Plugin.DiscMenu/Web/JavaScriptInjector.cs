using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;

namespace Jellyfin.Plugin.DiscMenu.Web;

/// <summary>
/// Registers the Disc menu button's loader with the JavaScript Injector plugin (n00bcodr/Jellyfin-JavaScript-Injector),
/// which adds it to every page of the web client. Injector is a separate plugin with no package to reference, so this
/// goes through its public <c>PluginInterface</c> by reflection, as its README describes.
/// </summary>
internal static class JavaScriptInjector
{
    /// <summary>
    /// Injector's assembly name.
    /// </summary>
    internal const string AssemblyName = "Jellyfin.Plugin.JavaScriptInjector";

    /// <summary>
    /// Injector's static class for other plugins.
    /// </summary>
    internal const string InterfaceType = AssemblyName + ".PluginInterface";

    /// <summary>
    /// The registered script's id in Injector's settings.
    /// </summary>
    internal const string ScriptId = PluginId + "-button";

    /// <summary>
    /// The script Injector runs once a user is signed in: it adds the button's script, served by this plugin, from the
    /// web client's own server root. The web client lives at <c>{base URL}/web/</c>, so the root is the path up to
    /// that; the address stays on the page's origin. No data goes into it.
    /// </summary>
    internal const string Loader =
        """
        (function () {
          var p = location.pathname, i = p.lastIndexOf("/web/");
          if (i < 0 || document.querySelector("script[data-disc-menu]")) return;
          var s = document.createElement("script");
          s.src = p.slice(0, i + 1) + "DiscMenu/Inject/button.js";
          s.setAttribute("data-disc-menu", "");
          document.head.appendChild(s);
        })();
        """;

    private const string PluginId = "bea19561-f7f9-44d6-a4d2-c46b41d04a94";

    /// <summary>
    /// What a registration did.
    /// </summary>
    internal enum Outcome
    {
        /// <summary>Injector took the script.</summary>
        Registered,

        /// <summary>Injector isn't installed.</summary>
        NotInstalled,

        /// <summary>Injector is installed, but has no <c>RegisterScript(JObject)</c> this code knows how to call.</summary>
        Unsupported,

        /// <summary>Injector refused the script (its log says why).</summary>
        Refused,
    }

    /// <summary>
    /// Finds Injector's <c>PluginInterface</c> among the loaded plugins.
    /// </summary>
    /// <returns>The type, or <c>null</c> when Injector isn't loaded.</returns>
    internal static Type? FindInterface()
    {
        return AssemblyLoadContext.All
            .SelectMany(context => context.Assemblies)
            .Where(assembly => string.Equals(assembly.GetName().Name, AssemblyName, StringComparison.Ordinal))
            .Select(assembly => assembly.GetType(InterfaceType, throwOnError: false))
            .FirstOrDefault(type => type is not null);
    }

    /// <summary>
    /// The registration Injector expects, as JSON.
    /// </summary>
    /// <param name="version">This plugin's version.</param>
    /// <returns>The payload.</returns>
    internal static string Payload(string version)
    {
        return JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["id"] = ScriptId,
            ["name"] = "Disc menu button",
            ["script"] = Loader,
            ["enabled"] = true,
            // The button needs the viewer's login, so it loads only once someone is signed in.
            ["requiresAuthentication"] = true,
            ["pluginId"] = PluginId,
            ["pluginName"] = "Disc Menu",
            ["pluginVersion"] = version,
        });
    }

    /// <summary>
    /// Registers the loader, or updates the registration from an earlier start or version.
    /// </summary>
    /// <param name="api">Injector's <c>PluginInterface</c>, from <see cref="FindInterface"/>.</param>
    /// <param name="version">This plugin's version.</param>
    /// <returns>What happened.</returns>
    /// <exception cref="TargetInvocationException">Injector threw.</exception>
    internal static Outcome Register(Type? api, string version)
    {
        if (api is null)
        {
            return Outcome.NotInstalled;
        }

        // RegisterScript takes a Newtonsoft JObject from Injector's own load context; build it with that type's Parse,
        // so this plugin needs no Newtonsoft of its own.
        var register = api.GetMethod("RegisterScript", BindingFlags.Public | BindingFlags.Static);
        var payloadType = register?.GetParameters() is [var parameter] ? parameter.ParameterType : null;
        var parse = payloadType?.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)]);
        if (register is null || parse is null || register.ReturnType != typeof(bool))
        {
            return Outcome.Unsupported;
        }

        var payload = parse.Invoke(null, [Payload(version)]);
        return register.Invoke(null, [payload]) is true ? Outcome.Registered : Outcome.Refused;
    }

    /// <summary>
    /// Removes every script this plugin registered.
    /// </summary>
    /// <param name="api">Injector's <c>PluginInterface</c>, from <see cref="FindInterface"/>.</param>
    /// <returns>How many Injector removed.</returns>
    /// <exception cref="TargetInvocationException">Injector threw.</exception>
    internal static int Unregister(Type? api)
    {
        var unregister = api?.GetMethod("UnregisterAllScriptsFromPlugin", BindingFlags.Public | BindingFlags.Static, [typeof(string)]);
        return unregister?.Invoke(null, [PluginId]) is int removed ? removed : 0;
    }

    /// <summary>
    /// This plugin's version, as Injector shows it.
    /// </summary>
    /// <returns>The assembly version.</returns>
    internal static string Version()
    {
        return typeof(JavaScriptInjector).Assembly.GetName().Version?.ToString() ?? "0.0.0.0";
    }

    /// <summary>
    /// Whether an exception from a reflected call into Injector is one to log and carry on from: Injector is optional,
    /// and the Links entry still works without the button.
    /// </summary>
    /// <param name="ex">The exception.</param>
    /// <returns>Whether to catch it.</returns>
    internal static bool IsInjectorFailure(Exception ex)
    {
        return ex is TargetInvocationException or ArgumentException or MemberAccessException or InvalidOperationException
            or NotSupportedException or FormatException;
    }

    /// <summary>
    /// A line for the log about an outcome.
    /// </summary>
    /// <param name="outcome">The outcome.</param>
    /// <returns>The message.</returns>
    internal static string Describe(Outcome outcome)
    {
        return outcome switch
        {
            Outcome.Registered => "Registered the Disc menu button with JavaScript Injector",
            Outcome.NotInstalled => "JavaScript Injector isn't installed: no Disc menu button in the web client (the Links entry still works)",
            Outcome.Unsupported => "This JavaScript Injector has no RegisterScript this plugin can call: no Disc menu button",
            Outcome.Refused => "JavaScript Injector refused the Disc menu button (see its log lines)",
            _ => string.Format(CultureInfo.InvariantCulture, "Unknown outcome {0}", outcome),
        };
    }
}
