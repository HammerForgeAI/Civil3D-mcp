using Autodesk.AutoCAD.ApplicationServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

/// <summary>
/// Runs a scripted AutoCAD command-line sequence (Editor.CommandAsync) from
/// host work started by <see cref="CivilExecution.ExecuteCommandSequenceAsync{T}"/>
/// and detects a command that was left waiting at a prompt.
/// </summary>
internal static class CommandLineRunner
{
  // A command left waiting for input is reported with this code so callers can
  // stop a batch instead of feeding the next answers into a stale prompt.
  internal const string IncompleteCode = "CIVIL3D.COMMAND_FAILED";

  // Every command this runner has driven. Only the UI thread runs commands,
  // but the set is locked so a stray caller cannot corrupt it.
  private static readonly HashSet<string> DrivenCommands = new(StringComparer.OrdinalIgnoreCase);

  internal static async Task RunAsync(Document doc, string commandName, params object[] tokens)
  {
    // Editor.CommandAsync completes once its tokens are consumed, even when the
    // command is still waiting for more input (the acedCmdC coroutine model),
    // so a stuck command is detected below and a cancel is queued. That cancel
    // only runs after the host work returns, so check here that no command an
    // earlier request drove is still at a prompt before feeding it this
    // request's answers.
    var stale = FindActiveCommand(DrivenCommandsSnapshot());
    if (stale != null)
    {
      var stalePrompt = Convert.ToString(App.GetSystemVariable("LASTPROMPT"));
      QueueCancel(doc);
      throw new JsonRpcDispatchException(
        IncompleteCode,
        $"-{stale} from an earlier request is still waiting at prompt '{stalePrompt}', so -{commandName} was not started. A cancel was queued; retry the request.");
    }

    lock (DrivenCommands)
    {
      DrivenCommands.Add(commandName);
    }

    await doc.Editor.CommandAsync(tokens);

    // A token the command did not expect (renamed prompt in a future release,
    // unexpected paper-size dialog, ...) leaves the command waiting for input.
    // Detect that instead of reporting success, record the pending prompt for
    // diagnosis, and queue a cancel so the editor is usable again.
    if (FindActiveCommand([commandName]) != null)
    {
      var lastPrompt = Convert.ToString(App.GetSystemVariable("LASTPROMPT"));
      QueueCancel(doc);
      throw new JsonRpcDispatchException(
        IncompleteCode,
        $"-{commandName} did not complete; it was waiting at prompt '{lastPrompt}'. A cancel was queued. The prompt chain may differ in this Civil 3D release.");
    }
  }

  private static string[] DrivenCommandsSnapshot()
  {
    lock (DrivenCommands)
    {
      return DrivenCommands.ToArray();
    }
  }

  private static string? FindActiveCommand(IReadOnlyCollection<string> commandNames)
  {
    if (commandNames.Count == 0)
    {
      return null;
    }

    var activeCommands = Convert.ToString(App.GetSystemVariable("CMDNAMES")) ?? string.Empty;
    return activeCommands
      .Split('\'')
      .Select(name => name.TrimStart('-', '_', '.'))
      .FirstOrDefault(name => commandNames.Contains(name, StringComparer.OrdinalIgnoreCase));
  }

  private static void QueueCancel(Document doc)
  {
    try
    {
      doc.SendStringToExecute("\x03\x03", true, false, false);
    }
    catch
    {
      // Best effort; the caller still reports the stuck command.
    }
  }
}
