using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;
using System.Text.Json.Nodes;

namespace Civil3DMcpPlugin;

/// <summary>
/// Creation handlers behind the civil3d_standards style_* actions:
/// createPointStyle, createPointLabelStyle, createLineLabelStyle, setTextStyleFont.
/// Ported from KevinGriffin `Civil3dMcpBridge.cs` (MIT) — CreatePointStyle:2154,
/// CreatePointLabelStyle:2245, CreateLineLabelStyle:2317, SetTextStyleFont:2658.
///
/// A name that already exists is CIVIL3D.CONFLICT, never a silent rename: Civil 3D's
/// style collections add " (1)" to a duplicate, which would create a style the caller
/// did not ask for.
/// </summary>
public static class StyleCreationCommands
{
  // ─── style_create_point ───────────────────────────────────────────────────

  public static Task<object?> CreatePointStyleAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");
    var description = PluginRuntime.GetOptionalString(parameters, "description");
    var markerType = PluginRuntime.GetOptionalString(parameters, "markerType");
    var markerSize = PluginRuntime.GetOptionalDouble(parameters, "markerSize");
    var useDrawingScale = PluginRuntime.GetOptionalBool(parameters, "useDrawingScale");
    var blockName = PluginRuntime.GetOptionalString(parameters, "blockName");
    var rotation = PluginRuntime.GetOptionalDouble(parameters, "rotation");

    if (!string.IsNullOrWhiteSpace(blockName) && !string.IsNullOrWhiteSpace(markerType))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT",
        "Pass only one of 'blockName' (a drawing block becomes the marker) and 'markerType' (a built-in marker shape). "
        + "The plugin would otherwise ignore one of them.");
    }

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var existing = FindStyleByName(civilDoc.Styles.PointStyles, transaction, name);
      if (existing != null)
      {
        throw new JsonRpcDispatchException("CIVIL3D.CONFLICT",
          $"Point style '{name}' already exists (handle {existing}).");
      }

      var styleId = civilDoc.Styles.PointStyles.Add(name);
      var style = (PointStyle)(transaction.GetObject(styleId, OpenMode.ForWrite)
        ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
          $"Point style '{name}' was added but could not be opened for write."));

      SetProperty(style, "Description", description, "point style", name, required: false);

      if (!string.IsNullOrWhiteSpace(blockName))
      {
        // A drawing block supplies the marker symbol, exactly as the donor does.
        SetPropertyRequired(style, "MarkerType", "UseSymbolForMarker", "point style", name);
        SetPropertyRequired(style, "MarkerSymbolName", blockName, "point style", name);
      }
      else
      {
        SetPropertyRequired(style, "MarkerType", "UseCustomMarker", "point style", name);
        SetPropertyRequired(style, "CustomMarkerStyle", CustomMarkerName(markerType), "point style", name);

        // MarkerSize is a marker-style double (MarkerStyleBase.MarkerSize), so the donor's 2.0
        // default is valid as written.
        var size = markerSize ?? 2.0;
        if (size <= 0)
        {
          throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT",
            $"markerSize must be greater than zero, but '{size}' was requested. No point style was created.");
        }

        SetPropertyRequired(style, "SizeType", useDrawingScale == false ? "FixedScale" : "DrawingScale", "point style", name);
        SetPropertyRequired(style, "MarkerSize", size, "point style", name);
      }

      SetPropertyRequired(style, "Display3dType", "UsePointElevation", "point style", name);

      if (rotation.HasValue)
      {
        SetPropertyRequired(style, "MarkerRotationAngle", rotation.Value, "point style", name);
      }

      return new Dictionary<string, object?>
      {
        ["created"] = true,
        ["name"] = name,
        ["handle"] = CivilObjectUtils.GetHandle(style),
        ["markerType"] = string.IsNullOrWhiteSpace(blockName) ? CustomMarkerName(markerType) : "block",
        ["blockName"] = string.IsNullOrWhiteSpace(blockName) ? null : blockName,
      };
    });
  }

  // ─── style_create_point_label ─────────────────────────────────────────────

  public static Task<object?> CreatePointLabelStyleAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");
    var description = PluginRuntime.GetOptionalString(parameters, "description");

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var collection = civilDoc.Styles.LabelStyles.PointLabelStyles.LabelStyles;

      var existing = FindStyleByName(collection, transaction, name);
      if (existing != null)
      {
        throw new JsonRpcDispatchException("CIVIL3D.CONFLICT",
          $"Point label style '{name}' already exists (handle {existing}).");
      }

      var styleId = collection.Add(name);
      var style = (LabelStyle)(transaction.GetObject(styleId, OpenMode.ForWrite)
        ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
          $"Point label style '{name}' was added but could not be opened for write."));

      // LabelStyle carries no written Description property in the donor either; report a
      // refused description rather than pretending it was stored.
      SetProperty(style, "Description", description, "point label style", name, required: false);

      return new Dictionary<string, object?>
      {
        ["created"] = true,
        ["name"] = name,
        ["handle"] = CivilObjectUtils.GetHandle(style),
        ["labelType"] = "point",
      };
    });
  }

  // ─── style_create_line_label ──────────────────────────────────────────────

  public static Task<object?> CreateLineLabelStyleAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");
    var description = PluginRuntime.GetOptionalString(parameters, "description");

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var collection = civilDoc.Styles.LabelStyles.GeneralLineLabelStyles;

      var existing = FindStyleByName(collection, transaction, name);
      if (existing != null)
      {
        throw new JsonRpcDispatchException("CIVIL3D.CONFLICT",
          $"Line label style '{name}' already exists (handle {existing}).");
      }

      var styleId = collection.Add(name);
      var style = (LabelStyle)(transaction.GetObject(styleId, OpenMode.ForWrite)
        ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
          $"Line label style '{name}' was added but could not be opened for write."));

      SetProperty(style, "Description", description, "line label style", name, required: false);

      return new Dictionary<string, object?>
      {
        ["created"] = true,
        ["name"] = name,
        ["handle"] = CivilObjectUtils.GetHandle(style),
        ["labelType"] = "line",
      };
    });
  }

  // ─── style_set_text_font ──────────────────────────────────────────────────

  public static Task<object?> SetTextStyleFontAsync(JsonObject? parameters)
  {
    var styleName = PluginRuntime.GetRequiredString(parameters, "styleName");
    var font = PluginRuntime.GetRequiredString(parameters, "font");

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var textStyleTable = (TextStyleTable)(transaction.GetObject(database.TextStyleTableId, OpenMode.ForRead)
        ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", "The drawing has no text style table."));

      if (!textStyleTable.Has(styleName))
      {
        throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
          $"Text style '{styleName}' was not found. Available: {DescribeTextStyles(textStyleTable, transaction)}.");
      }

      var record = (TextStyleTableRecord)(transaction.GetObject(textStyleTable[styleName], OpenMode.ForWrite)
        ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
          $"Text style '{styleName}' could not be opened for write."));

      var previousFont = record.FileName;
      var changed = !string.Equals(previousFont, font, StringComparison.OrdinalIgnoreCase);
      if (changed)
      {
        record.FileName = font;
      }

      return new Dictionary<string, object?>
      {
        ["updated"] = true,
        ["changed"] = changed,
        ["styleName"] = record.Name,
        ["font"] = record.FileName,
        ["previousFont"] = previousFont,
      };
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /// <summary>
  /// The built-in marker name the donor switch (Civil3dMcpBridge.cs:2185) maps from the
  /// request string; "plus" is its default. Only the four shapes that switch implements
  /// reach here — the schema enum rejects the rest.
  /// </summary>
  private static string CustomMarkerName(string? markerType)
  {
    return (markerType ?? "plus").ToLowerInvariant() switch
    {
      "plus" => "CustomMarkerPlus",
      "x" => "CustomMarkerX",
      "dot" => "CustomMarkerDot",
      "vline" => "CustomMarkerVLine",
      var other => throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT",
        $"Unsupported markerType '{other}'. Valid values: plus, x, dot, vline."),
    };
  }

  /// <summary>Handle of an existing style with this name (case-insensitive), or null.</summary>
  private static string? FindStyleByName(object collection, Transaction transaction, string name)
  {
    foreach (var objectId in CivilObjectUtils.ToObjectIds(collection))
    {
      if (objectId == ObjectId.Null)
      {
        continue;
      }

      var style = transaction.GetObject(objectId, OpenMode.ForRead);
      if (style != null && string.Equals(CivilObjectUtils.GetName(style), name, StringComparison.OrdinalIgnoreCase))
      {
        return CivilObjectUtils.GetHandle(style);
      }
    }

    return null;
  }

  /// <summary>
  /// Sets a style property through Civil3DCompatibility. <paramref name="required"/> keeps a
  /// creation-critical write honest: the caller sees the Civil 3D member name that refused the
  /// value instead of a style that silently kept its default.
  /// </summary>
  private static void SetProperty(object style, string propertyName, object? value, string kind, string name, bool required)
  {
    if (value == null)
    {
      return;
    }

    if (!Civil3DCompatibility.TrySetProperty(style, propertyName, value))
    {
      if (!required)
      {
        return;
      }

      throw new JsonRpcDispatchException("CIVIL3D.API_ERROR",
        $"Civil 3D did not accept '{propertyName}' for {kind} '{name}'. No {kind} was created.");
    }
  }

  private static void SetPropertyRequired(object style, string propertyName, object? value, string kind, string name)
  {
    SetProperty(style, propertyName, value, kind, name, required: true);
  }

  private static string DescribeTextStyles(TextStyleTable textStyleTable, Transaction transaction)
  {
    var names = new List<string>();
    foreach (var objectId in textStyleTable)
    {
      if (objectId == ObjectId.Null)
      {
        continue;
      }

      var record = transaction.GetObject(objectId, OpenMode.ForRead) as TextStyleTableRecord;
      if (!string.IsNullOrWhiteSpace(record?.Name))
      {
        names.Add($"'{record!.Name}'");
      }
    }

    return names.Count == 0 ? "none" : string.Join(", ", names);
  }
}
