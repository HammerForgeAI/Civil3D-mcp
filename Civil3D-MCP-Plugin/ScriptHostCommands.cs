using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.Civil.ApplicationServices;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

/// <summary>
/// P11 item 1: the gated C# script host. Ported from barbosaihan/civil3d-mcp
/// RoslynExecutor.cs and nezolder/civil3d-mcp-roslyn (both MIT).
///
/// It is unreachable without an approval token. The TypeScript approval policy
/// classifies `execute_script` as a non-retryable mutation, so only a token
/// issued by civil3d_request_approval for the exact script text gets as far as
/// this method, and <see cref="ApprovalTokenGuard"/> refuses the call again
/// when the token is missing, forged or reused.
///
/// Roslyn's assembly resolution stays inside the reflection boundary:
/// <see cref="Civil3DCompatibility.GetLoadedScriptReferenceAssemblies"/> owns
/// the enumeration of the process's loaded assemblies, so this file contains no
/// reflection marker of its own (tests/reflection_boundary.test.ts).
/// </summary>
internal static class ScriptHostCommands
{
  private const int MaxScriptSeconds = 120;
  private const int MaxCachedScripts = 32;

  // Cached by the exact source text, not by a hash: a hash collision would run
  // the wrong script. The cache is size-capped instead of hash-keyed.
  private static readonly ConcurrentDictionary<string, Script<object>> ScriptCache = new(StringComparer.Ordinal);

  private static readonly string[] ScriptImports = new[]
  {
    "System",
    "System.Linq",
    "System.Collections.Generic",
    "System.Text",
    "Autodesk.AutoCAD.ApplicationServices",
    "Autodesk.AutoCAD.DatabaseServices",
    "Autodesk.AutoCAD.EditorInput",
    "Autodesk.AutoCAD.Geometry",
    "Autodesk.AutoCAD.Runtime",
    "Autodesk.Civil",
    "Autodesk.Civil.ApplicationServices",
    "Autodesk.Civil.DatabaseServices",
    "Autodesk.Civil.Settings",
  };

  internal static async Task<object?> ExecuteCSharpScriptAsync(JsonObject? parameters)
  {
    ApprovalTokenGuard.Require(parameters, "executeCSharpScript");

    var code = PluginRuntime.GetRequiredString(parameters, "code");
    ScriptSandbox.Validate(code);

    var timeoutSeconds = Math.Clamp(
      PluginRuntime.GetOptionalInt(parameters, "timeoutSeconds") ?? MaxScriptSeconds,
      1,
      MaxScriptSeconds);

    return await CivilExecution.ExecuteInCommandContextAsync(async () =>
    {
      var document = App.DocumentManager.MdiActiveDocument
        ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
      var civilDocument = CivilApplication.ActiveDocument
        ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active Civil 3D document is available.");

      // CivilExecution.ExecuteAsync opens the document lock and a transaction,
      // but it takes a synchronous action keyed on a result, so an async script
      // cannot run inside it. The script host therefore takes the same command
      // context and opens the same lock + transaction itself, and commits only
      // after the script returns without throwing.
      using var documentLock = document.LockDocument();
      using var transaction = document.Database.TransactionManager.StartTransaction();
      var context = new ScriptContext(document, civilDocument, document.Database, transaction);
      var script = GetOrCreateScript(code);

      using var timeout = CancellationTokenSource.CreateLinkedTokenSource(
        PluginRuntime.GetCurrentRequestCancellationToken());
      timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

      ScriptState<object> state;
      try
      {
        state = await script.RunAsync(context, timeout.Token);
      }
      catch (OperationCanceledException) when (!PluginRuntime.GetCurrentRequestCancellationToken().IsCancellationRequested)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.TIMEOUT",
          $"Script execution timed out after {timeoutSeconds}s.");
      }
      catch (CompilationErrorException error)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.INVALID_INPUT",
          "C# compilation failed:\n" + string.Join("\n", error.Diagnostics));
      }

      transaction.Commit();
      return DescribeResult(state.ReturnValue);
    });
  }

  private static Script<object> GetOrCreateScript(string code)
  {
    if (ScriptCache.TryGetValue(code, out var cached))
    {
      return cached;
    }

    var options = ScriptOptions.Default
      .WithReferences(Civil3DCompatibility.GetLoadedScriptReferenceAssemblies())
      .WithImports(ScriptImports)
      .WithAllowUnsafe(false);

    var script = CSharpScript.Create<object>(code, options, typeof(ScriptContext));
    if (ScriptCache.Count < MaxCachedScripts)
    {
      ScriptCache.TryAdd(code, script);
    }

    return script;
  }

  // A script may return anything, and the RPC layer serializes the result to
  // JSON. Only scalars survive that trip, so everything else is reported by its
  // text form plus its type name instead of letting serialization fail.
  private static object DescribeResult(object? value)
  {
    if (value == null)
    {
      return new Dictionary<string, object?>
      {
        ["returned"] = false,
        ["value"] = null,
        ["returnType"] = null,
        ["isScalar"] = false,
      };
    }

    var type = value.GetType();
    var isScalar = value is string || value is bool || value is decimal || type.IsPrimitive;
    return new Dictionary<string, object?>
    {
      ["returned"] = true,
      ["value"] = isScalar ? value : value.ToString(),
      ["returnType"] = type.FullName,
      ["isScalar"] = isScalar,
    };
  }
}
