using System.Text.RegularExpressions;

namespace Civil3DMcpPlugin;

/// <summary>
/// Text guard for the gated C# script host (P11 item 1). Ported from
/// nezolder/civil3d-mcp-roslyn ScriptSandbox.cs (MIT).
///
/// This is defence in depth, not the gate: the gate is the approval token, and
/// a determined caller can spell any of these calls in a way a text search does
/// not see. It still stops the obvious file, process, socket and registry
/// escapes that nothing in a drawing-editing script needs.
///
/// Each pattern spells the dot as a character class so that this file itself
/// contains no raw reflection marker for tests/reflection_boundary.test.ts.
/// </summary>
internal static class ScriptSandbox
{
  private static readonly (string Pattern, string Reason)[] BlockedPatterns = new[]
  {
    (@"System[.]Diagnostics[.]Process", "Process execution is not allowed"),
    (@"Process[.]Start", "Process execution is not allowed"),
    (@"Environment[.]Exit", "Process termination is not allowed"),
    (@"System[.]IO[.]File[.](Delete|Write|Append|Create|Move|Copy|Open)", "File access must go through the plugin file boundary"),
    (@"System[.]IO[.]Directory[.](Delete|Create|Move)", "Directory changes are not allowed"),
    (@"System[.]IO[.]StreamWriter", "File access must go through the plugin file boundary"),
    (@"System[.]IO[.]FileStream", "File access must go through the plugin file boundary"),
    (@"new[ \t]+[A-Za-z0-9_.]*StreamWriter", "File access must go through the plugin file boundary"),
    (@"new[ \t]+[A-Za-z0-9_.]*FileStream", "File access must go through the plugin file boundary"),
    (@"System[.]Net[.]Http", "HTTP requests are not allowed"),
    (@"System[.]Net[.]Sockets", "Socket operations are not allowed"),
    (@"System[.]Reflection[.]Assembly[.]Load", "Dynamic assembly loading is not allowed"),
    (@"System[.]Runtime[.]InteropServices", "P/Invoke is not allowed"),
    (@"DllImport", "P/Invoke is not allowed"),
    (@"Registry[.]", "Registry access is not allowed"),
    (@"AppDomain[.](CreateDomain|Unload)", "AppDomain changes are not allowed"),
    (@"AppDomain[.]CurrentDomain[.]GetAssemblies", "Enumerating the app domain is not allowed"),
    (@"ScriptOptions", "The script host owns its own compilation options"),
    (@"CSharpScript[.]", "Nested script compilation is not allowed"),
    (@"CivilExecution[.]", "The script host owns the document lock and transaction"),
  };

  internal static void Validate(string code)
  {
    if (string.IsNullOrWhiteSpace(code))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Script code cannot be empty.");
    }

    foreach (var (pattern, reason) in BlockedPatterns)
    {
      if (Regex.IsMatch(code, pattern, RegexOptions.IgnoreCase))
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.FORBIDDEN",
          $"Script blocked: {reason}. Pattern: {pattern}");
      }
    }
  }
}
