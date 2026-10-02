namespace Civil3DMcpPlugin;

/// <summary>
/// P11 item 21: the listener's instance reporting, ported from
/// nezolder/civil3d-mcp-roslyn EndpointRegistration (MIT). The donor publishes
/// one record per Civil 3D session naming the instance, the process and the
/// port; the fork reports the same fields over the listener itself, as
/// `getListenerInstance`, so the MCP server can list instances without reading
/// the donor's endpoint directory.
///
/// The identity is per plugin load: two Civil 3D sessions of the same version
/// answer with different instance ids.
/// </summary>
internal static class ListenerInstance
{
  internal const int SchemaVersion = 1;

  internal static string InstanceId { get; } = Guid.NewGuid().ToString("N");
  internal static DateTimeOffset StartedAtUtc { get; } = DateTimeOffset.UtcNow;

  internal static object Describe()
  {
    return new Dictionary<string, object?>
    {
      ["schemaVersion"] = SchemaVersion,
      ["instanceId"] = InstanceId,
      ["processId"] = Environment.ProcessId,
      ["listenerPort"] = PluginRuntime.Port,
      ["startedAtUtc"] = StartedAtUtc.ToString("O"),
      ["pluginVersion"] = typeof(PluginEntry).Assembly.GetName().Version?.ToString(),
    };
  }
}
