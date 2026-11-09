using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.DiscMenu.Web;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.DiscMenu.Tests;

public sealed class JavaScriptInjectorTests
{
    [Fact]
    public void Register_hands_Injector_the_loader_as_its_own_payload_type()
    {
        FakeInjector.Reset();

        var outcome = JavaScriptInjector.Register(typeof(FakeInjector), "0.3.0.0");

        Assert.Equal(JavaScriptInjector.Outcome.Registered, outcome);
        var payload = Assert.Single(FakeInjector.Registered);
        using var json = JsonDocument.Parse(payload.Json);
        var root = json.RootElement;
        Assert.Equal("bea19561-f7f9-44d6-a4d2-c46b41d04a94-button", root.GetProperty("id").GetString());
        Assert.Equal("bea19561-f7f9-44d6-a4d2-c46b41d04a94", root.GetProperty("pluginId").GetString());
        Assert.Equal("Disc Menu", root.GetProperty("pluginName").GetString());
        Assert.Equal("0.3.0.0", root.GetProperty("pluginVersion").GetString());
        Assert.True(root.GetProperty("enabled").GetBoolean());
        Assert.True(root.GetProperty("requiresAuthentication").GetBoolean());
        Assert.Equal(JavaScriptInjector.Loader, root.GetProperty("script").GetString());
        Assert.False(root.TryGetProperty("src", out _));
    }

    [Fact]
    public void The_loader_adds_the_plugins_script_from_the_web_clients_own_root()
    {
        Assert.Contains("lastIndexOf(\"/web/\")", JavaScriptInjector.Loader, StringComparison.Ordinal);
        Assert.Contains("\"DiscMenu/Inject/button.js\"", JavaScriptInjector.Loader, StringComparison.Ordinal);
        Assert.DoesNotContain("http", JavaScriptInjector.Loader, StringComparison.Ordinal);
        Assert.DoesNotContain("innerHTML", JavaScriptInjector.Loader, StringComparison.Ordinal);
    }

    [Fact]
    public void Register_reports_a_missing_or_unknown_Injector()
    {
        Assert.Equal(JavaScriptInjector.Outcome.NotInstalled, JavaScriptInjector.Register(null, "1"));
        Assert.Equal(JavaScriptInjector.Outcome.Unsupported, JavaScriptInjector.Register(typeof(NoParse), "1"));
        Assert.Equal(JavaScriptInjector.Outcome.Unsupported, JavaScriptInjector.Register(typeof(string), "1"));
    }

    [Fact]
    public void Register_reports_a_refusal()
    {
        FakeInjector.Reset();
        FakeInjector.Accept = false;

        Assert.Equal(JavaScriptInjector.Outcome.Refused, JavaScriptInjector.Register(typeof(FakeInjector), "1"));
    }

    [Fact]
    public void Unregister_removes_this_plugins_scripts()
    {
        FakeInjector.Reset();

        Assert.Equal(1, JavaScriptInjector.Unregister(typeof(FakeInjector)));
        Assert.Equal(["bea19561-f7f9-44d6-a4d2-c46b41d04a94"], FakeInjector.Unregistered);
        Assert.Equal(0, JavaScriptInjector.Unregister(null));
    }

    [Fact]
    public void FindInterface_finds_nothing_without_Injector()
    {
        Assert.Null(JavaScriptInjector.FindInterface());
    }

    [Fact]
    public async Task The_hosted_service_registers_and_survives_Injector_throwing()
    {
        FakeInjector.Reset();
        await new InjectorRegistration(NullLogger<InjectorRegistration>.Instance, () => typeof(FakeInjector)).StartAsync(CancellationToken.None);
        Assert.Single(FakeInjector.Registered);

        FakeInjector.Reset();
        FakeInjector.Throw = true;
        var service = new InjectorRegistration(NullLogger<InjectorRegistration>.Instance, () => typeof(FakeInjector));
        await service.StartAsync(CancellationToken.None);
        await service.StopAsync(CancellationToken.None);

        await new InjectorRegistration(NullLogger<InjectorRegistration>.Instance, () => null).StartAsync(CancellationToken.None);
    }

    [Fact]
    public void Every_outcome_has_a_log_line()
    {
        Assert.Contains("Registered", JavaScriptInjector.Describe(JavaScriptInjector.Outcome.Registered), StringComparison.Ordinal);
        Assert.Contains("isn't installed", JavaScriptInjector.Describe(JavaScriptInjector.Outcome.NotInstalled), StringComparison.Ordinal);
        Assert.Contains("no RegisterScript", JavaScriptInjector.Describe(JavaScriptInjector.Outcome.Unsupported), StringComparison.Ordinal);
        Assert.Contains("refused", JavaScriptInjector.Describe(JavaScriptInjector.Outcome.Refused), StringComparison.Ordinal);
    }

    [Fact]
    public void Only_reflection_and_argument_failures_are_caught()
    {
        Assert.True(JavaScriptInjector.IsInjectorFailure(new TargetInvocationException(new InvalidOperationException())));
        Assert.True(JavaScriptInjector.IsInjectorFailure(new ArgumentException("x")));
        Assert.False(JavaScriptInjector.IsInjectorFailure(new System.IO.IOException("disk")));
    }

    /// <summary>Stands in for Newtonsoft's JObject in Injector's load context: a type with a static Parse(string).</summary>
    internal sealed class FakePayload
    {
        private FakePayload(string json) => Json = json;

        public string Json { get; }

        public static FakePayload Parse(string json) => new(json);
    }

    /// <summary>Stands in for Injector's PluginInterface.</summary>
    internal static class FakeInjector
    {
        public static List<FakePayload> Registered { get; } = [];

        public static List<string> Unregistered { get; } = [];

        public static bool Accept { get; set; } = true;

        public static bool Throw { get; set; }

        public static void Reset()
        {
            Registered.Clear();
            Unregistered.Clear();
            Accept = true;
            Throw = false;
        }

        public static bool RegisterScript(FakePayload payload)
        {
            if (Throw)
            {
                throw new InvalidOperationException("JavaScript Injector plugin instance is not available.");
            }

            Registered.Add(payload);
            return Accept;
        }

        public static int UnregisterAllScriptsFromPlugin(string pluginId)
        {
            Unregistered.Add(pluginId);
            return 1;
        }
    }

    /// <summary>A RegisterScript whose payload type has no Parse.</summary>
    internal static class NoParse
    {
        public static bool RegisterScript(System.Text.StringBuilder payload) => payload is not null;
    }
}
