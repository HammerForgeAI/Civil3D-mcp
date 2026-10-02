using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using System.Text.Json.Nodes;

namespace Civil3DMcpPlugin;

public static class LayerXrefCommands
{
  /// <summary>Read-only layer table dump (name, ACI color, linetype, frozen/off/locked/plot, xref-dependent). The plugin could not
  /// read layer state before, which forced a Core Console dump of the SAVED file just to know whether C-TINN-BNDY is frozen.</summary>
  public static Task<object?> ListLayersAsync(JsonObject? parameters)
  {
    var exactName = PluginRuntime.GetOptionalString(parameters, "name");
    var pattern = PluginRuntime.GetOptionalString(parameters, "namePattern");
    var includeXref = PluginRuntime.GetOptionalBool(parameters, "includeXref") ?? true;
    var limit = Math.Clamp(PluginRuntime.GetOptionalInt(parameters, "limit") ?? 2000, 1, 5000);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var layerTable = CivilObjectUtils.GetRequiredObject<LayerTable>(transaction, database.LayerTableId, OpenMode.ForRead);
      var layers = new List<Dictionary<string, object?>>();
      var totalLayers = 0;
      var matched = 0;
      foreach (ObjectId layerId in layerTable)
      {
        totalLayers++;
        var layer = CivilObjectUtils.GetRequiredObject<LayerTableRecord>(transaction, layerId, OpenMode.ForRead);
        if (!string.IsNullOrWhiteSpace(exactName) && !layer.Name.Equals(exactName, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }

        if (!string.IsNullOrWhiteSpace(pattern) && !System.IO.Enumeration.FileSystemName.MatchesSimpleExpression(pattern, layer.Name, true))
        {
          continue;
        }

        if (!includeXref && layer.IsDependent)
        {
          continue;
        }

        matched++;
        if (layers.Count >= limit)
        {
          continue;
        }

        var linetypeName = string.Empty;
        try
        {
          linetypeName = CivilObjectUtils.GetRequiredObject<LinetypeTableRecord>(transaction, layer.LinetypeObjectId, OpenMode.ForRead).Name;
        }
        catch (Exception)
        {
          // a layer whose linetype record cannot be opened still reports its state
        }

        layers.Add(new Dictionary<string, object?>
        {
          ["name"] = layer.Name,
          ["colorIndex"] = (int)layer.Color.ColorIndex,
          ["linetype"] = linetypeName,
          ["lineweight"] = (int)layer.LineWeight,
          ["isFrozen"] = layer.IsFrozen,
          ["isOff"] = layer.IsOff,
          ["isLocked"] = layer.IsLocked,
          ["isPlottable"] = layer.IsPlottable,
          ["isXrefDependent"] = layer.IsDependent,
          ["handle"] = CivilObjectUtils.GetHandle(layer),
        });
      }

      return new Dictionary<string, object?>
      {
        ["totalLayers"] = totalLayers,
        ["matched"] = matched,
        ["count"] = layers.Count,
        ["truncated"] = matched > layers.Count,
        ["layers"] = layers,
      };
    });
  }

  public static Task<object?> CreateOrUpdateLayerAsync(JsonObject? parameters)
  {
    var layerName = PluginRuntime.GetRequiredString(parameters, "name");
    var colorIndex = PluginRuntime.GetOptionalInt(parameters, "colorIndex");
    var linetype = PluginRuntime.GetOptionalString(parameters, "linetype");
    var lineweight = PluginRuntime.GetOptionalInt(parameters, "lineweight");
    var plot = PluginRuntime.GetOptionalBool(parameters, "plot");
    var frozen = PluginRuntime.GetOptionalBool(parameters, "frozen");
    var locked = PluginRuntime.GetOptionalBool(parameters, "locked");

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var layerTable = CivilObjectUtils.GetRequiredObject<LayerTable>(transaction, database.LayerTableId, OpenMode.ForRead);

      LayerTableRecord layer;
      bool created;
      if (layerTable.Has(layerName))
      {
        layer = CivilObjectUtils.GetRequiredObject<LayerTableRecord>(transaction, layerTable[layerName], OpenMode.ForWrite);
        created = false;
      }
      else
      {
        var layerTableWrite = CivilObjectUtils.GetRequiredObject<LayerTable>(transaction, database.LayerTableId, OpenMode.ForWrite);
        layer = new LayerTableRecord { Name = layerName };
        layerTableWrite.Add(layer);
        transaction.AddNewlyCreatedDBObject(layer, true);
        created = true;
      }

      if (colorIndex.HasValue)
      {
        layer.Color = Color.FromColorIndex(ColorMethod.ByAci, (short)colorIndex.Value);
      }

      if (!string.IsNullOrWhiteSpace(linetype))
      {
        layer.LinetypeObjectId = LookupUtils.GetOrLoadLinetypeId(database, transaction, linetype);
      }

      if (lineweight.HasValue)
      {
        layer.LineWeight = (LineWeight)lineweight.Value;
      }

      if (plot.HasValue)
      {
        layer.IsPlottable = plot.Value;
      }

      if (frozen.HasValue)
      {
        layer.IsFrozen = frozen.Value;
      }

      if (locked.HasValue)
      {
        layer.IsLocked = locked.Value;
      }

      return new Dictionary<string, object?>
      {
        ["name"] = layer.Name,
        ["created"] = created,
        ["colorIndex"] = layer.Color.ColorMethod == ColorMethod.ByAci ? (int)layer.Color.ColorIndex : (int?)null,
        ["linetype"] = LookupUtils.GetLinetypeName(transaction, layer.LinetypeObjectId),
        ["lineweight"] = (int)layer.LineWeight,
        ["plot"] = layer.IsPlottable,
        ["frozen"] = layer.IsFrozen,
        ["locked"] = layer.IsLocked,
      };
    });
  }
}
