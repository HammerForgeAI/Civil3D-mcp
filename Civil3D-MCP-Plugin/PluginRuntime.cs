using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

public sealed record PluginStatus(
  bool IsRunning,
  bool OperationInProgress,
  string? CurrentOperation,
  int QueueDepth,
  int QueueCapacity,
  long? CurrentOperationStartedAtUnixMs,
  string? CurrentRequestId);

/// <summary>
/// One stage of a host operation. Item 29 (P8), ported from Peter-Ewald/Civil3D-mcp
/// (MIT, Copyright (c) 2025 lisiting01): Civil3D-MCP-Plugin/PluginRuntime.cs
/// (`PluginStatus.CurrentStage`, `RecordOperationStage`) and its
/// `HostOperationTrace`. The donor published the live stage and its duration;
/// this adds the start time, the completed history, and the stalled verdict.
/// </summary>
public sealed record OperationStageTelemetry(
  string Name,
  long StartedAtUnixMs,
  long DurationMs,
  string State);

/// <summary>
/// Per-stage timing for <c>civil3d_health</c>. <c>civil3d_health</c> does not
/// acquire the host gate, so this still answers while an operation is stuck.
/// </summary>
public sealed record StageTelemetrySnapshot(
  string? CurrentStage,
  long? CurrentStageStartedAtUnixMs,
  long? CurrentStageDurationMs,
  string? CurrentStageState,
  int StallThresholdMs,
  IReadOnlyList<OperationStageTelemetry> Stages);

public sealed class JsonRpcDispatchException : Exception
{
  public JsonRpcDispatchException(string code, string message) : base(message)
  {
    Code = code;
  }

  public string Code { get; }
}

public static class PluginRuntime
{
  public const int Port = 8080;

  private static readonly object Sync = new();
  private static RpcTcpServer? _server;
  private static readonly AsyncLocal<string?> CurrentRequestOperation = new();
  private static readonly AsyncLocal<string?> CurrentRequestId = new();
  private static readonly AsyncLocal<CancellationToken> CurrentRequestCancellation = new();
  private static readonly AsyncLocal<string?> CurrentExpectedDrawingIdentity = new();
  private const int MaxQueuedHostOperations = 64;
  private static int _queueDepth;
  private static int _activeOperations;
  private static string? _currentOperation;
  private static string? _currentRequestId;
  private static long? _currentOperationStartedAtUnixMs;

  /// <summary>
  /// A stage that stays open at least this long is reported as <c>stalled</c>
  /// rather than <c>running</c>. The donor used 5 s as its slow-operation log
  /// threshold; a stall verdict is a stronger claim than "slow", and the two
  /// stages below include the queue wait, so the reported threshold is
  /// published with the data instead of being left implicit.
  /// </summary>
  public const int StageStallThresholdMs = 30_000;

  internal static class StageState
  {
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Stalled = "stalled";
  }

  /// <summary>
  /// The stages this fork can observe from PluginRuntime itself: the wait for
  /// the host gate, and the host execution that follows it. The fork's
  /// CivilExecution pipeline exposes no finer named stages.
  /// </summary>
  internal static class StageName
  {
    public const string Queued = "queued";
    public const string HostExecution = "host-execution";
  }

  private const int MaxRetainedStages = 16;
  private static readonly List<OperationStageTelemetry> CompletedStages = new();
  private static string? _currentStage;
  private static long _currentStageStartedAtUnixMs;

  // Per request, not global: several callers can sit in the host queue at once,
  // and only the one that reaches the gate owns the published stage.
  private static readonly AsyncLocal<long> CurrentRequestQueuedAtUnixMs = new();

  public static void StartServer()
  {
    lock (Sync)
    {
      if (_server != null)
      {
        return;
      }

      _server = new RpcTcpServer(Port, HandleRawRequestAsync);
      _server.Start();
    }
  }

  public static void StopServer()
  {
    lock (Sync)
    {
      _server?.Stop();
      _server = null;
      _currentOperation = null;
      _activeOperations = 0;
      _queueDepth = 0;
      _currentRequestId = null;
      _currentOperationStartedAtUnixMs = null;
      _currentStage = null;
      _currentStageStartedAtUnixMs = 0;
      CompletedStages.Clear();
    }
  }

  public static PluginStatus GetStatus()
  {
    lock (Sync)
    {
      return new PluginStatus(
        _server != null,
        _activeOperations > 0,
        _currentOperation,
        _queueDepth,
        MaxQueuedHostOperations,
        _currentOperationStartedAtUnixMs,
        _currentRequestId);
    }
  }

  public static async Task<string> HandleRawRequestAsync(string rawRequest, CancellationToken cancellationToken)
  {
    JsonNode? parsed;
    try
    {
      parsed = JsonNode.Parse(rawRequest);
    }
    catch (Exception ex)
    {
      return JsonRpcProtocol.SerializeError(null, -32700, "CIVIL3D.INVALID_JSON", $"Invalid JSON request: {ex.Message}");
    }

    if (parsed is not JsonObject request)
    {
      return JsonRpcProtocol.SerializeError(null, -32600, "CIVIL3D.INVALID_REQUEST", "JSON-RPC request must be an object.");
    }

    var id = request["id"]?.DeepClone();
    if (request["jsonrpc"] is not JsonValue versionValue
      || !versionValue.TryGetValue<string>(out var version)
      || version != "2.0")
    {
      return JsonRpcProtocol.SerializeError(id, -32600, "CIVIL3D.INVALID_REQUEST", "JSON-RPC request must specify jsonrpc='2.0'.");
    }

    var method = request["method"] is JsonValue methodValue
      && methodValue.TryGetValue<string>(out var methodText)
      ? methodText
      : null;

    if (string.IsNullOrWhiteSpace(method))
    {
      return JsonRpcProtocol.SerializeError(id, -32600, "CIVIL3D.INVALID_REQUEST", "JSON-RPC request is missing a string method.");
    }

    if (request["params"] != null && request["params"] is not JsonObject)
    {
      return JsonRpcProtocol.SerializeError(id, -32602, "CIVIL3D.INVALID_INPUT", "JSON-RPC params must be an object when provided.");
    }
    var parameters = request["params"] as JsonObject;

    var previousOperation = CurrentRequestOperation.Value;
    var previousRequestId = CurrentRequestId.Value;
    var previousCancellation = CurrentRequestCancellation.Value;
    CurrentRequestOperation.Value = method;
    CurrentRequestId.Value = id?.ToJsonString();
    CurrentRequestCancellation.Value = cancellationToken;

    var timer = System.Diagnostics.Stopwatch.StartNew();
    try
    {
      PluginLog.Debug("Dispatch", $"-> {method} [{CurrentRequestId.Value ?? "no-id"}]");
      var result = await CommandDispatcher.DispatchAsync(method, parameters, cancellationToken);
      PluginLog.Debug("Dispatch", $"<- {method} [{CurrentRequestId.Value ?? "no-id"}] ok durationMs={timer.ElapsedMilliseconds}");
      return JsonRpcProtocol.SerializeResult(id, result);
    }
    catch (JsonRpcDispatchException ex)
    {
      // Domain-level errors are part of the contract; record at info so they
      // show up in diagnostics without looking like runtime faults.
      PluginLog.Info("Dispatch", $"<- {method} [{CurrentRequestId.Value ?? "no-id"}] dispatch error {ex.Code} durationMs={timer.ElapsedMilliseconds}: {ex.Message}");
      return JsonRpcProtocol.SerializeError(id, JsonRpcProtocol.NumericErrorCode(ex.Code), ex.Code, ex.Message);
    }
    catch (OperationCanceledException)
    {
      PluginLog.Info("Dispatch", $"<- {method} [{CurrentRequestId.Value ?? "no-id"}] cancelled durationMs={timer.ElapsedMilliseconds}");
      return JsonRpcProtocol.SerializeError(id, -32010, "CIVIL3D.CANCELLED", $"Operation '{method}' was cancelled.");
    }
    catch (Exception ex)
    {
      PluginLog.Error("Dispatch", $"<- {method} [{CurrentRequestId.Value ?? "no-id"}] unhandled failure durationMs={timer.ElapsedMilliseconds} category={ex.GetType().Name}", ex);
      return JsonRpcProtocol.SerializeError(id, -32603, "CIVIL3D.INTERNAL_ERROR", "The Civil 3D plugin encountered an unexpected error.");
    }
    finally
    {
      CurrentRequestOperation.Value = previousOperation;
      CurrentRequestId.Value = previousRequestId;
      CurrentRequestCancellation.Value = previousCancellation;
    }
  }

  internal static CancellationToken GetCurrentRequestCancellationToken() => CurrentRequestCancellation.Value;

  internal static string GetCurrentRequestOperation() => CurrentRequestOperation.Value ?? "Civil 3D operation";

  internal static string? GetCurrentRequestId() => CurrentRequestId.Value;

  internal static string? GetActiveDrawingIdentity()
  {
    var document = App.DocumentManager.MdiActiveDocument;
    return GetDrawingIdentity(document);
  }

  internal static string? GetDrawingIdentity(Autodesk.AutoCAD.ApplicationServices.Document? document)
  {
    if (document == null) return null;
    var fileName = document.Database.Filename;
    return string.IsNullOrWhiteSpace(fileName) ? document.Name : fileName;
  }

  internal static string? GetExpectedDrawingIdentity() => CurrentExpectedDrawingIdentity.Value;

  internal static async Task<T> RunWithRequestContextAsync<T>(
    string operation,
    string requestId,
    CancellationToken cancellationToken,
    string? expectedDrawingIdentity,
    Func<Task<T>> action)
  {
    var previousOperation = CurrentRequestOperation.Value;
    var previousRequestId = CurrentRequestId.Value;
    var previousCancellation = CurrentRequestCancellation.Value;
    var previousExpectedDrawingIdentity = CurrentExpectedDrawingIdentity.Value;
    CurrentRequestOperation.Value = operation;
    CurrentRequestId.Value = requestId;
    CurrentRequestCancellation.Value = cancellationToken;
    CurrentExpectedDrawingIdentity.Value = expectedDrawingIdentity;
    try
    {
      return await action();
    }
    finally
    {
      CurrentRequestOperation.Value = previousOperation;
      CurrentRequestId.Value = previousRequestId;
      CurrentRequestCancellation.Value = previousCancellation;
      CurrentExpectedDrawingIdentity.Value = previousExpectedDrawingIdentity;
    }
  }

  internal static void QueueHostOperation()
  {
    lock (Sync)
    {
      if (_queueDepth >= MaxQueuedHostOperations)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.HOST_BUSY",
          $"Civil 3D host queue is full ({MaxQueuedHostOperations} operations). Retry after current work completes.");
      }

      _queueDepth++;
    }

    CurrentRequestQueuedAtUnixMs.Value = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
  }

  internal static void StartHostOperation()
  {
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    var queuedAt = CurrentRequestQueuedAtUnixMs.Value;
    lock (Sync)
    {
      _queueDepth = Math.Max(0, _queueDepth - 1);
      _activeOperations++;
      _currentOperation = GetCurrentRequestOperation();
      _currentRequestId = GetCurrentRequestId();
      _currentOperationStartedAtUnixMs = now;

      // The host gate is exclusive, so whatever ran before this request has
      // closed its stages already: this operation is the one to describe.
      CompletedStages.Clear();
      if (queuedAt > 0)
      {
        AppendCompletedStageLocked(StageName.Queued, queuedAt, Math.Max(0, now - queuedAt));
      }

      _currentStage = StageName.HostExecution;
      _currentStageStartedAtUnixMs = now;
    }
  }

  internal static void CancelQueuedHostOperation()
  {
    lock (Sync)
    {
      _queueDepth = Math.Max(0, _queueDepth - 1);
    }
  }

  internal static void CompleteHostOperation()
  {
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    lock (Sync)
    {
      _activeOperations = Math.Max(0, _activeOperations - 1);
      if (_activeOperations == 0)
      {
        _currentOperation = null;
        _currentRequestId = null;
        _currentOperationStartedAtUnixMs = null;
        if (_currentStage != null)
        {
          AppendCompletedStageLocked(_currentStage, _currentStageStartedAtUnixMs, Math.Max(0, now - _currentStageStartedAtUnixMs));
          _currentStage = null;
          _currentStageStartedAtUnixMs = 0;
        }
      }
    }
  }

  private static void AppendCompletedStageLocked(string name, long startedAtUnixMs, long durationMs)
  {
    CompletedStages.Add(new OperationStageTelemetry(name, startedAtUnixMs, durationMs, StageState.Completed));
    while (CompletedStages.Count > MaxRetainedStages)
    {
      CompletedStages.RemoveAt(0);
    }
  }

  /// <summary>
  /// Per-stage timing for the health surface: the stage the active operation is
  /// in, its start, its duration so far, and whether it completed or has
  /// stalled, followed by the stages that already completed for that operation.
  /// </summary>
  public static StageTelemetrySnapshot GetStageTelemetry()
  {
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    lock (Sync)
    {
      var stages = new List<OperationStageTelemetry>(CompletedStages);
      long? currentDurationMs = null;
      string? currentState = null;
      if (_currentStage != null)
      {
        var elapsed = Math.Max(0, now - _currentStageStartedAtUnixMs);
        var state = elapsed >= StageStallThresholdMs ? StageState.Stalled : StageState.Running;
        currentDurationMs = elapsed;
        currentState = state;
        stages.Add(new OperationStageTelemetry(_currentStage, _currentStageStartedAtUnixMs, elapsed, state));
      }

      return new StageTelemetrySnapshot(
        _currentStage,
        _currentStage == null ? null : _currentStageStartedAtUnixMs,
        currentDurationMs,
        currentState,
        StageStallThresholdMs,
        stages);
    }
  }

  public static object? GetParameter(JsonObject? parameters, string name)
  {
    if (parameters == null)
    {
      return null;
    }

    return parameters.TryGetPropertyValue(name, out var value) ? value : null;
  }

  public static string GetRequiredString(JsonObject? parameters, string name)
  {
    var value = GetParameter(parameters, name) as JsonNode;
    if (value == null)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Missing required parameter '{name}'.");
    }

    var stringValue = value.GetValue<string>();
    if (string.IsNullOrWhiteSpace(stringValue))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Parameter '{name}' must be a non-empty string.");
    }

    return stringValue;
  }

  public static double GetRequiredDouble(JsonObject? parameters, string name)
  {
    var value = GetParameter(parameters, name) as JsonNode;
    if (value == null)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Missing required parameter '{name}'.");
    }

    return value.GetValue<double>();
  }

  public static int GetRequiredInt(JsonObject? parameters, string name)
  {
    var value = GetParameter(parameters, name) as JsonNode;
    if (value == null)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Missing required parameter '{name}'.");
    }

    return value.GetValue<int>();
  }

  public static string? GetOptionalString(JsonObject? parameters, string name)
  {
    var value = GetParameter(parameters, name) as JsonNode;
    return value == null ? null : value.GetValue<string?>();
  }

  public static double? GetOptionalDouble(JsonObject? parameters, string name)
  {
    var value = GetParameter(parameters, name) as JsonNode;
    return value == null ? null : value.GetValue<double>();
  }

  public static int? GetOptionalInt(JsonObject? parameters, string name)
  {
    var value = GetParameter(parameters, name) as JsonNode;
    return value == null ? null : value.GetValue<int>();
  }

  public static bool? GetOptionalBool(JsonObject? parameters, string name)
  {
    var value = GetParameter(parameters, name) as JsonNode;
    return value == null ? null : value.GetValue<bool>();
  }

}
