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

  internal static async Task RunAsync(Document doc, string commandName, params object[] tokens)
  {
    await doc.Editor.CommandAsync(tokens);

    // A token the command did not expect (renamed prompt in a future release,
    // unexpected paper-size dialog, ...) leaves the command waiting for input.
    // Detect that instead of reporting success, record the pending prompt for
    // diagnosis, and queue a cancel so the editor is usable again.
    var activeCommands = Convert.ToString(App.GetSystemVariable("CMDNAMES")) ?? string.Empty;
    if (activeCommands.Split('\'').Any(name => name.TrimStart('-', '_', '.').Equals(commandName, StringComparison.OrdinalIgnoreCase)))
    {
      var lastPrompt = Convert.ToString(App.GetSystemVariable("LASTPROMPT"));
      try
      {
        doc.SendStringToExecute("\x03\x03", true, false, false);
      }
      catch
      {
        // Best effort; the error below still reports the stuck command.
      }
      throw new JsonRpcDispatchException(
        IncompleteCode,
        $"-{commandName} did not complete; it was waiting at prompt '{lastPrompt}'. A cancel was queued. The prompt chain may differ in this Civil 3D release.");
    }
  }
}
