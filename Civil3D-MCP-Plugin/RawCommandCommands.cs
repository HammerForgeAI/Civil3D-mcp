using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;

namespace Civil3DMcpPlugin;

/// <summary>
/// P11 item 16: the raw AutoCAD command-line passthrough (the `send_command`
/// escape hatch). Ported from KevinGriffin/new_civil3d_mcp Handlers.SendCommand
/// (MIT), with two changes.
///
/// 1. It runs inside the protected path. The TypeScript approval policy
///    classifies the action as a non-retryable mutation, so it is refused
///    without an approval token, and this method requires the token again
///    through <see cref="ApprovalTokenGuard"/> before any command is queued.
/// 2. It cannot bypass <see cref="FileBoundary"/>. A raw command line would
///    otherwise reach OPEN/SAVEAS/XREF/INSERT/PLOT/EXPORT (caller-named files
///    with no path control), NETLOAD/ARX/APPLOAD (arbitrary code), or SETVAR
///    (which would walk around the acad_set_system_variable allowlist). Those
///    commands are refused by name here, and the whole line must be a single
///    unquoted argv-style line so no LISP expression can be smuggled in.
///
/// The command runs through <see cref="CommandLineRunner"/>, which detects a
/// command left waiting at a prompt and queues a cancel, so a stuck escape
/// hatch cannot wedge the editor for the next call.
/// </summary>
internal static class RawCommandCommands
{
  private const int MaxCommandLength = 512;
  private const int MaxArguments = 40;

  // Compared against the command name with any leading '-'/'_'/'.' removed and
  // case folded, so "-SAVEAS" and "_saveas" are blocked too.
  private static readonly HashSet<string> BlockedCommands = new(StringComparer.OrdinalIgnoreCase)
  {
    // Caller-named files and drawing IO: FileBoundary owns every path.
    "OPEN", "NEW", "QNEW", "SAVE", "QSAVE", "SAVEAS", "SAVEALL", "RECOVER", "RECOVERALL",
    "XOPEN", "XREF", "XATTACH", "INSERT", "CLASSICINSERT", "WBLOCK", "IMPORT", "EXPORT",
    "DXFIN", "DXFOUT", "WMFIN", "WMFOUT", "IMAGEOUT", "IMAGEATTACH", "DATALINK",
    "PLOT", "PREVIEW", "PUBLISH", "DATAEXTRACTION", "SHEETSET", "SSM", "SCRIPT", "LAYERSTATE",
    // Arbitrary code and operating-system entry points.
    "NETLOAD", "ARX", "APPLOAD", "VLISP", "VLIDE", "VBALOAD", "STARTAPP", "SHELL", "DOSLIB", "COMMANDLINE",
    // Dialogs, configuration and system variables: the runner stays headless and
    // acad_set_system_variable keeps its fixed allowlist.
    "FILEDIA", "CMDDIA", "EXPERT", "ATTDIA", "SETVAR", "SYSVAR", "SYSVDLG", "UNDEFINE", "REDEFINE",
    "OPTIONS", "CONFIG", "PROFILES", "MENU", "CUI", "CUIEXPORT", "CUIIMPORT", "CUSTOMIZE", "TOOLPALETTES",
  };

  // Characters that would let one request carry a LISP expression, a second
  // command or a quoted path. Arguments belong in the 'arguments' array.
  private static readonly char[] ForbiddenCharacters = new[] { '\r', '\n', '(', ')', ';', '"', '`' };

  // Command names are aliases: acad.pgp maps 'I' to INSERT and 'XR' to XREF, so
  // a name list can never be complete. No token may name a file either, which
  // closes that hole for every alias at once.
  private static readonly string[] FileExtensions = new[]
  {
    ".dwg", ".dwt", ".dws", ".dxf", ".dwf", ".pdf", ".sat", ".stl",
    ".lsp", ".fas", ".dll", ".scr", ".shx", ".sv$", ".bak", ".tmp",
  };

  internal static async Task<object?> SendCommandAsync(JsonObject? parameters)
  {
    ApprovalTokenGuard.Require(parameters, "sendCommand");

    var command = PluginRuntime.GetRequiredString(parameters, "command");
    if (command.Length > MaxCommandLength)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"Parameter 'command' is longer than {MaxCommandLength} characters.");
    }

    if (command.IndexOfAny(ForbiddenCharacters) >= 0)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        "Parameter 'command' must be one unquoted command line: no quotes, parentheses, semicolons or line breaks. Pass extra tokens through 'arguments'.");
    }

    var explicitArguments = GetStringArray(parameters, "arguments");
    string[] parts;
    if (explicitArguments == null)
    {
      parts = command.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
    }
    else
    {
      if (command.IndexOfAny(new[] { ' ', '\t' }) >= 0)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.INVALID_INPUT",
          "With 'arguments' present, 'command' must be the command name alone.");
      }

      parts = new[] { command }.Concat(explicitArguments).ToArray();
    }

    if (parts.Length == 0)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Parameter 'command' must name an AutoCAD command.");
    }

    var commandName = NormalizeCommandName(parts[0]);
    if (commandName.Length == 0)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Parameter 'command' must name an AutoCAD command.");
    }

    if (BlockedCommands.Contains(commandName))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FORBIDDEN",
        $"Command '{commandName}' is refused by the raw command channel: it names a file, loads code, opens a dialog or changes a system variable, so it would bypass the file boundary, the managed API or the system-variable allowlist. Use the dedicated tool for it.");
    }

    RejectFileTokens(parts);

    // Editor.CommandAsync takes the command name and its answers as one token
    // list, which is exactly the argv shape built above.
    var invocation = new object[parts.Length];
    for (var index = 0; index < parts.Length; index++)
    {
      invocation[index] = parts[index];
    }

    return await CivilExecution.ExecuteCommandSequenceAsync<object?>(async (document, cancellationToken) =>
    {
      cancellationToken.ThrowIfCancellationRequested();
      await CommandLineRunner.RunAsync(document, commandName, invocation);
      return new Dictionary<string, object?>
      {
        ["command"] = commandName,
        ["arguments"] = parts.Skip(1).ToArray(),
        ["completed"] = true,
      };
    });
  }

  private static string NormalizeCommandName(string token) => token.TrimStart('-', '_', '.').Trim();

  // The channel is the drawing escape hatch, not a file API: no token may carry
  // a path or a drawing/code file name, so no alias can turn it into OPEN,
  // SAVEAS, XREF, INSERT, WBLOCK, PLOT or APPLOAD behind FileBoundary's back.
  private static void RejectFileTokens(string[] parts)
  {
    foreach (var token in parts)
    {
      if (!NamesAFile(token))
      {
        continue;
      }

      throw new JsonRpcDispatchException(
        "CIVIL3D.FORBIDDEN",
        $"Token '{token}' names a file, and the raw command channel never passes a caller-supplied path. Use the tool that owns the file operation, so it runs inside the file boundary.");
    }
  }

  private static bool NamesAFile(string token)
  {
    if (token.IndexOf('/') >= 0 || token.IndexOf('\\') >= 0)
    {
      return true;
    }

    if (token.Length > 1 && token[1] == ':' && char.IsLetter(token[0]))
    {
      return true;
    }

    var lowered = token.ToLowerInvariant();
    return FileExtensions.Any(extension => lowered.EndsWith(extension, StringComparison.Ordinal));
  }

  private static string[]? GetStringArray(JsonObject? parameters, string name)
  {
    if (PluginRuntime.GetParameter(parameters, name) is not JsonArray array)
    {
      return null;
    }

    if (array.Count == 0 || array.Count > MaxArguments)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"Parameter '{name}' must hold between 1 and {MaxArguments} entries.");
    }

    var values = new string[array.Count];
    for (var index = 0; index < array.Count; index++)
    {
      if (array[index] is not JsonValue value || !value.TryGetValue<string>(out var text) || string.IsNullOrWhiteSpace(text))
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.INVALID_INPUT",
          $"Every entry of '{name}' must be a non-empty string.");
      }

      values[index] = text;
    }

    return values;
  }
}
