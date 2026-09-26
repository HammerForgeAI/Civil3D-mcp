using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

public static partial class CivilExecution
{
  // Same host gate, command context, drawing-identity check, and document
  // lock as ExecuteAsync, but WITHOUT an enclosing transaction. Some database
  // operations (xref unload/detach, data-shortcut repair) manage their own
  // internal transactions and must not run nested inside an open top
  // transaction; the callback opens short transactions of its own where it
  // needs to read.
  public static async Task<T> ExecuteLockedWithoutTransactionAsync<T>(Func<Document, CivilDocument, Database, T> action)
  {
    return await ExecuteSerializedAsync(async () =>
    {
      // Fail fast with no document: the command-context hop below never fires
      // without one, and the request would hold the host gate indefinitely.
      if (App.DocumentManager.MdiActiveDocument == null)
      {
        throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
      }

      var cancellationToken = PluginRuntime.GetCurrentRequestCancellationToken();
      T? result = default;
      Exception? capturedException = null;

      await App.DocumentManager.ExecuteInCommandContextAsync(async _ =>
      {
        try
        {
          cancellationToken.ThrowIfCancellationRequested();
          var doc = App.DocumentManager.MdiActiveDocument ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
          var expectedDrawingIdentity = PluginRuntime.GetExpectedDrawingIdentity();
          var activeDrawingIdentity = PluginRuntime.GetDrawingIdentity(doc);
          if (!string.IsNullOrWhiteSpace(expectedDrawingIdentity) &&
              !string.Equals(expectedDrawingIdentity, activeDrawingIdentity, StringComparison.OrdinalIgnoreCase))
          {
            throw new JsonRpcDispatchException(
              "CIVIL3D.CONFLICT",
              $"The active drawing changed from '{expectedDrawingIdentity}' to '{activeDrawingIdentity}' while the operation was queued. No drawing changes were made.");
          }
          var civilDoc = CivilApplication.ActiveDocument ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active Civil 3D document is available.");

          using var documentLock = doc.LockDocument();
          result = action(doc, civilDoc, doc.Database);
        }
        catch (Exception ex)
        {
          capturedException = ex;
        }

        await Task.CompletedTask;
      }, null);

      if (capturedException != null)
      {
        System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(capturedException).Throw();
      }

      return result!;
    });
  }
}
