using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;

namespace Civil3DMcpPlugin;

/// <summary>
/// P2 (implementation plan item 12) — block intelligence: the block-definition inventory and an
/// exact block-reference count, read straight from the drawing's block table (no geometry
/// interpretation, so the result is exact).
/// Ported from DaniGhosy/civil3d-mcp plugin/Civil3dMcpPlugin/BlockCommands.cs
/// (MIT, Copyright (c) 2025 lisiting01). Only the two actions this fork was missing are kept here:
/// list/insert/update of block references already live in AcadCommands.cs, so the donor's other
/// four methods are deliberately not duplicated.
/// The donor resolves a block's insertions through
/// BlockTableRecord.GetBlockReferenceIds(directOnly, forceOpenOnLockedLayer) instead of scanning
/// model space and comparing names, which is the precise API for "every insertion of THIS block".
/// </summary>
public static class BlockCommands
{
  public static Task<object?> ListBlockDefinitionsAsync()
  {
    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var blockTable = CivilObjectUtils.GetRequiredObject<BlockTable>(transaction, database.BlockTableId, OpenMode.ForRead);
      var blocks = new List<Dictionary<string, object?>>();

      foreach (ObjectId blockId in blockTable)
      {
        var record = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, blockId, OpenMode.ForRead);
        if (record.IsAnonymous || record.IsLayout)
        {
          continue;
        }

        blocks.Add(new Dictionary<string, object?>
        {
          ["name"] = record.Name,
          ["insertionCount"] = record.GetBlockReferenceIds(true, false).Count,
          ["isDynamicBlock"] = record.IsDynamicBlock,
        });
      }

      return new Dictionary<string, object?> { ["blocks"] = blocks };
    });
  }

  public static Task<object?> CountBlocksByNameAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");
    var layoutFilter = PluginRuntime.GetOptionalString(parameters, "layout");

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var record = ResolveBlockDefinition(transaction, database, name);
      var count = 0;

      foreach (ObjectId referenceId in record.GetBlockReferenceIds(true, false))
      {
        if (layoutFilter != null && !MatchesLayout(transaction, referenceId, layoutFilter))
        {
          continue;
        }

        count++;
      }

      return new Dictionary<string, object?>
      {
        ["name"] = name,
        ["layout"] = layoutFilter,
        ["count"] = count,
      };
    });
  }

  // ── Helpers (private to this file; no shared fork helper is duplicated) ──

  private static BlockTableRecord ResolveBlockDefinition(Transaction transaction, Database database, string name)
  {
    var blockTable = CivilObjectUtils.GetRequiredObject<BlockTable>(transaction, database.BlockTableId, OpenMode.ForRead);
    if (!blockTable.Has(name))
    {
      throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Block definition '{name}' not found.");
    }

    return CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, blockTable[name], OpenMode.ForRead);
  }

  private static bool MatchesLayout(Transaction transaction, ObjectId blockReferenceId, string layoutName)
  {
    var reference = CivilObjectUtils.GetRequiredObject<BlockReference>(transaction, blockReferenceId, OpenMode.ForRead);
    var owner = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, reference.OwnerId, OpenMode.ForRead);
    if (owner.LayoutId.IsNull)
    {
      return false;
    }

    var layout = CivilObjectUtils.GetRequiredObject<Layout>(transaction, owner.LayoutId, OpenMode.ForRead);
    return string.Equals(layout.LayoutName, layoutName, StringComparison.OrdinalIgnoreCase);
  }
}
