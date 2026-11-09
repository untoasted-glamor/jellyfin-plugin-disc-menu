using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.DiscMenu.Web;

/// <summary>
/// Registers the Disc menu button with JavaScript Injector when the server starts. Hosted services start after every
/// plugin has been created, so Injector is ready by then. Injector keeps the registration in its own settings; doing it
/// on every start updates it after a Disc Menu update.
/// </summary>
public sealed class InjectorRegistration : IHostedService
{
    private readonly ILogger<InjectorRegistration> _logger;
    private readonly Func<Type?> _findInterface;

    /// <summary>
    /// Initializes a new instance of the <see cref="InjectorRegistration"/> class.
    /// </summary>
    /// <param name="logger">The logger.</param>
    public InjectorRegistration(ILogger<InjectorRegistration> logger)
        : this(logger, JavaScriptInjector.FindInterface)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="InjectorRegistration"/> class, with another way to find Injector.
    /// </summary>
    /// <param name="logger">The logger.</param>
    /// <param name="findInterface">Finds Injector's <c>PluginInterface</c>.</param>
    internal InjectorRegistration(ILogger<InjectorRegistration> logger, Func<Type?> findInterface)
    {
        _logger = logger;
        _findInterface = findInterface;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var outcome = JavaScriptInjector.Register(_findInterface(), JavaScriptInjector.Version());
            var message = JavaScriptInjector.Describe(outcome);
            if (outcome == JavaScriptInjector.Outcome.Registered || outcome == JavaScriptInjector.Outcome.NotInstalled)
            {
                _logger.LogInformation("{Message}", message);
            }
            else
            {
                _logger.LogWarning("{Message}", message);
            }
        }
        catch (Exception ex) when (JavaScriptInjector.IsInjectorFailure(ex))
        {
            _logger.LogWarning(ex, "Couldn't register the Disc menu button with JavaScript Injector");
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
