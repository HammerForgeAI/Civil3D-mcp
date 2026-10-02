using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;

namespace Civil3DMcpPlugin;

/// <summary>
/// Plan Production view frames and match lines — read-only listers.
///
/// Civil 3D 2027 exposes Autodesk.Civil.DatabaseServices.ViewFrame, ViewFrameGroup and
/// MatchLine as entities that live in model space, so both listers scan model space the
/// same way the label and block readers do. Autodesk documents no managed creation API for
/// view frames, view frame groups, sheets or match lines, so this file reads and never
/// creates, and it publishes no action that could be mistaken for a creator.
///
/// The donor of this port (DaniGhosy, MIT) shipped the same two listers with no tests and
/// listed the area as a dead end, so this is fresh development against this fork's
/// conventions, not a copy: it reuses Civil3DCompatibility for the property dump, resolves
/// the owning view frame group, and never takes the donor's unguarded group read.
///
/// The limit parameter caps how many model-space entries are inspected (default 200,
/// maximum 500), matching the other model-space listers.
/// </summary>
public static class FrameMatchLineCommands
{
  private const int DefaultLimit = 200;
  private const int MaxLimit = 500;

  // -------------------------------------------------------------------------
  // listViewFrames
  // -------------------------------------------------------------------------

  public static Task<object?> ListViewFramesAsync(JsonObject? parameters)
  {
    var requestedLimit = PluginRuntime.GetOptionalInt(parameters, "limit") ?? DefaultLimit;
    var limit = Math.Clamp(requestedLimit, 1, MaxLimit);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var viewFrames = new List<Dictionary<string, object?>>();
      var modelSpace = ReadModelSpace(database, transaction);

      foreach (ObjectId objectId in modelSpace)
      {
        if (viewFrames.Count >= limit)
        {
          break;
        }

        if (transaction.GetObject(objectId, OpenMode.ForRead) is not ViewFrame viewFrame)
        {
          continue;
        }

        var entry = new Dictionary<string, object?>
        {
          ["name"] = viewFrame.Name,
          ["handle"] = viewFrame.Handle.ToString(),
          ["layer"] = viewFrame.Layer,
          ["properties"] = Civil3DCompatibility.GetReadableScalarProperties(viewFrame),
        };

        AddOwningGroupIdentity(entry, transaction, viewFrame.GroupId);
        viewFrames.Add(entry);
      }

      return new Dictionary<string, object?> { ["viewFrames"] = viewFrames };
    });
  }

  // -------------------------------------------------------------------------
  // listMatchLines
  // -------------------------------------------------------------------------

  public static Task<object?> ListMatchLinesAsync(JsonObject? parameters)
  {
    var requestedLimit = PluginRuntime.GetOptionalInt(parameters, "limit") ?? DefaultLimit;
    var limit = Math.Clamp(requestedLimit, 1, MaxLimit);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var matchLines = new List<Dictionary<string, object?>>();
      var modelSpace = ReadModelSpace(database, transaction);

      foreach (ObjectId objectId in modelSpace)
      {
        if (matchLines.Count >= limit)
        {
          break;
        }

        if (transaction.GetObject(objectId, OpenMode.ForRead) is not MatchLine matchLine)
        {
          continue;
        }

        var entry = new Dictionary<string, object?>
        {
          ["name"] = matchLine.Name,
          ["handle"] = matchLine.Handle.ToString(),
          ["layer"] = matchLine.Layer,
          ["properties"] = Civil3DCompatibility.GetReadableScalarProperties(matchLine),
        };

        AddOwningGroupIdentity(entry, transaction, matchLine.GroupId);
        matchLines.Add(entry);
      }

      return new Dictionary<string, object?> { ["matchLines"] = matchLines };
    });
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private static BlockTableRecord ReadModelSpace(Database database, Transaction transaction)
  {
    return CivilObjectUtils.GetRequiredObject<BlockTableRecord>(
      transaction,
      CivilObjectUtils.GetModelSpaceBlockId(database, transaction),
      OpenMode.ForRead);
  }

  /// <summary>
  /// Records the view frame group that owns a view frame or match line. Both objects expose
  /// GroupId, and a frame that was never grouped reports ObjectId.Null, so the two keys stay
  /// null in that case. A group whose type is something else is left null rather than guessed.
  /// </summary>
  private static void AddOwningGroupIdentity(Dictionary<string, object?> entry, Transaction transaction, ObjectId groupId)
  {
    entry["groupHandle"] = null;
    entry["groupName"] = null;

    if (groupId.IsNull)
    {
      return;
    }

    ViewFrameGroup? group = null;
    try
    {
      group = transaction.GetObject(groupId, OpenMode.ForRead) as ViewFrameGroup;
    }
    catch (Autodesk.AutoCAD.Runtime.Exception ex)
    {
      PluginLog.Swallow("PlanProduction", "read view frame group", ex);
    }

    if (group == null)
    {
      return;
    }

    entry["groupHandle"] = group.Handle.ToString();
    entry["groupName"] = group.Name;
  }
}
