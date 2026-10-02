namespace Civil3DMcpPlugin;

/// <summary>
/// Item 29 (P8): publishes PluginRuntime's per-stage telemetry on the health
/// surface. The behaviour is ported from Peter-Ewald/Civil3D-mcp (MIT,
/// Copyright (c) 2025 lisiting01), whose execution trace and
/// <c>civil3d_health</c> stage fields are recorded in
/// <see cref="PluginRuntime"/>. The health command itself is unchanged; this
/// attaches the stage block to it, so <c>getCivil3DHealth</c> keeps reporting
/// everything it reported before and gains the per-stage timing.
/// </summary>
public static class StageTelemetryCommands
{
  private const string StageTelemetryField = "stageTelemetry";

  /// <summary>
  /// The health payload plus per-stage telemetry. Health deliberately does not
  /// acquire the host gate, so the stage block still answers while an operation
  /// is holding it - which is the state worth inspecting.
  /// </summary>
  public static async Task<object?> GetCivil3DHealthWithStagesAsync()
  {
    var health = await DrawingCommands.GetCivil3DHealthAsync();
    if (health is not IDictionary<string, object?> healthFields)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INTERNAL_ERROR",
        "The Civil 3D health payload was not a field dictionary, so stage telemetry could not be attached.");
    }

    healthFields[StageTelemetryField] = PluginRuntime.GetStageTelemetry();
    return healthFields;
  }

  /// <summary>
  /// The stage block alone, for a direct probe that does not pay for the rest
  /// of the health payload.
  /// </summary>
  public static Task<object?> GetStageTelemetryAsync()
  {
    return Task.FromResult<object?>(PluginRuntime.GetStageTelemetry());
  }
}
