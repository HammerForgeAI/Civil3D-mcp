using System.Text.Json.Nodes;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace Civil3DMcpPlugin;

/// <summary>
/// P2 (implementation plan item 18) — hatch creation. The domain could already LIST Hatch entities
/// through listShapeEntities; this adds creation.
/// Ported from Jjo37/new-acad plugin/AcBridge-v24/src/HatchCommands.cs (MIT,
/// Copyright (c) 2025-2026 Jjo), CreateHatchAsync only. The donor's importHatches / editHatch are
/// not part of item 18 and stay out.
/// Order matters and is the donor's verified order: AppendEntity + AddNewlyCreatedDBObject, then
/// SetDatabaseDefaults, then the pattern (or the gradient), then AppendLoop, and EvaluateHatch
/// only after the entity is in the database.
/// Target framework: the fork builds against the Civil 3D 2027 managed references
/// (net10.0-windows).
/// </summary>
public static class HatchCommands
{
  private static HatchStyle ParseStyle(string? islandStyle) => (islandStyle ?? string.Empty).ToLowerInvariant() switch
  {
    "outer" => HatchStyle.Outer,
    "ignore" => HatchStyle.Ignore,
    _ => HatchStyle.Normal,
  };

  private static string StyleName(HatchStyle style) => style switch
  {
    HatchStyle.Outer => "outer",
    HatchStyle.Ignore => "ignore",
    _ => "normal",
  };

  /// <summary>Appends one loop from {points:[{x,y}|[x,y]], bulges?:[]}; loop 0 is External, the rest are Default islands.</summary>
  private static bool TryAddLoop(Hatch hatch, JsonNode? loopNode, int index, string? islandStyle, out string error)
  {
    error = string.Empty;
    var pointsNode = loopNode is JsonObject loopObject ? loopObject["points"] as JsonArray : loopNode as JsonArray;
    if (pointsNode == null || pointsNode.Count < 3)
    {
      error = "a loop needs at least 3 points";
      return false;
    }

    var vertices = new Point2dCollection();
    for (var i = 0; i < pointsNode.Count; i++)
    {
      double x;
      double y;
      var pointNode = pointsNode[i];
      if (pointNode is JsonArray pair && pair.Count >= 2 && pair[0] != null && pair[1] != null)
      {
        x = pair[0]!.GetValue<double>();
        y = pair[1]!.GetValue<double>();
      }
      else if (pointNode is JsonObject pointObject && pointObject["x"] != null && pointObject["y"] != null)
      {
        x = pointObject["x"]!.GetValue<double>();
        y = pointObject["y"]!.GetValue<double>();
      }
      else
      {
        error = $"point {i} is not an {{x,y}} object or a [x,y] pair";
        return false;
      }

      vertices.Add(new Point2d(x, y));
    }

    var bulges = new DoubleCollection();
    for (var i = 0; i < vertices.Count; i++)
    {
      bulges.Add(0);
    }

    if (loopNode is JsonObject loopWithBulges && loopWithBulges["bulges"] is JsonArray bulgeNode)
    {
      for (var i = 0; i < bulgeNode.Count && i < bulges.Count; i++)
      {
        try
        {
          var bulge = bulgeNode[i]!.GetValue<double>();
          if (!double.IsNaN(bulge) && !double.IsInfinity(bulge))
          {
            bulges[i] = Math.Max(-1.9, Math.Min(1.9, bulge));
          }
        }
        catch
        {
          // An unparsable bulge stays 0 (straight segment).
        }
      }
    }

    var loopType = index == 0
      ? HatchLoopTypes.External
      : (string.Equals(islandStyle, "outermost", StringComparison.OrdinalIgnoreCase) ? HatchLoopTypes.Outermost : HatchLoopTypes.Default);

    hatch.AppendLoop(loopType, vertices, bulges);
    return true;
  }

  private static Dictionary<string, object?> Describe(Hatch hatch)
  {
    return new Dictionary<string, object?>
    {
      ["pattern"] = hatch.PatternName,
      ["patternType"] = hatch.PatternType.ToString(),
      ["isSolid"] = string.Equals(hatch.PatternName, "SOLID", StringComparison.OrdinalIgnoreCase) || hatch.IsSolidFill,
      ["isGradient"] = hatch.IsGradient,
      ["gradientName"] = hatch.IsGradient ? hatch.GradientName : null,
      ["gradientAngle"] = hatch.IsGradient ? hatch.GradientAngle : (double?)null,
      ["gradientOneColor"] = hatch.IsGradient ? hatch.GradientOneColorMode : (bool?)null,
      ["gradientColors"] = hatch.IsGradient ? (object?)GradientColorsOf(hatch) : null,
      ["patternScale"] = hatch.PatternScale,
      ["patternAngle"] = hatch.PatternAngle,
      ["islandStyle"] = StyleName(hatch.HatchStyle),
      ["associative"] = hatch.Associative,
      ["area"] = hatch.Area,
      ["loopCount"] = hatch.NumberOfLoops,
      ["layer"] = hatch.Layer,
    };
  }

  /// <summary>[[r,g,b],[r,g,b],...] to GradientColor[] with values spread evenly from 0 to 1.</summary>
  private static List<GradientColor>? ParseGradientColors(JsonNode? node)
  {
    if (node is not JsonArray colors || colors.Count < 2)
    {
      return null;
    }

    var parsed = new List<GradientColor>();
    for (var i = 0; i < colors.Count; i++)
    {
      if (colors[i] is not JsonArray rgb || rgb.Count < 3 || rgb[0] == null || rgb[1] == null || rgb[2] == null)
      {
        return null;
      }

      var color = Color.FromRgb((byte)rgb[0]!.GetValue<int>(), (byte)rgb[1]!.GetValue<int>(), (byte)rgb[2]!.GetValue<int>());
      parsed.Add(new GradientColor(color, (float)i / (colors.Count - 1)));
    }

    return parsed;
  }

  // GradientColor's Color/Value members are properties on some builds and get_Color()/get_Value()
  // methods on others, so every read goes through the Civil3DCompatibility boundary.
  private static List<Dictionary<string, object?>> GradientColorsOf(Hatch hatch)
  {
    var colors = new List<Dictionary<string, object?>>();
    try
    {
      foreach (var gradientColor in hatch.GetGradientColors())
      {
        var color = Civil3DCompatibility.GetPropertyValue(gradientColor, "Color")
          ?? Civil3DCompatibility.InvokeMethod(gradientColor, "get_Color");
        var value = Civil3DCompatibility.GetPropertyValue(gradientColor, "Value")
          ?? Civil3DCompatibility.InvokeMethod(gradientColor, "get_Value");

        colors.Add(new Dictionary<string, object?>
        {
          ["r"] = color == null ? null : Civil3DCompatibility.GetPropertyValue(color, "Red") ?? Civil3DCompatibility.InvokeMethod(color, "get_Red"),
          ["g"] = color == null ? null : Civil3DCompatibility.GetPropertyValue(color, "Green") ?? Civil3DCompatibility.InvokeMethod(color, "get_Green"),
          ["b"] = color == null ? null : Civil3DCompatibility.GetPropertyValue(color, "Blue") ?? Civil3DCompatibility.InvokeMethod(color, "get_Blue"),
          ["value"] = value,
        });
      }
    }
    catch (Autodesk.AutoCAD.Runtime.Exception)
    {
      // A hatch that reports no readable gradient colors returns an empty list.
    }

    return colors;
  }

  public static Task<object?> CreateHatchAsync(JsonObject? parameters)
  {
    var loopsNode = PluginRuntime.GetParameter(parameters, "loops") as JsonArray;
    var pointsNode = PluginRuntime.GetParameter(parameters, "points") as JsonArray;
    if ((loopsNode == null || loopsNode.Count == 0) && (pointsNode == null || pointsNode.Count < 3))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT",
        "createHatch requires 'loops':[{points,bulges?},...] (multiple loops / islands) or 'points':[...] (one loop) with at least 3 points.");
    }

    var pattern = PluginRuntime.GetOptionalString(parameters, "pattern") ?? "SOLID";
    var scale = PluginRuntime.GetOptionalDouble(parameters, "scale") ?? 1.0;
    var angle = PluginRuntime.GetOptionalDouble(parameters, "angle") ?? 0.0;
    var layerName = PluginRuntime.GetOptionalString(parameters, "layer");
    var islandStyle = PluginRuntime.GetOptionalString(parameters, "islandStyle");
    var associative = PluginRuntime.GetOptionalBool(parameters, "associative") ?? false;
    var colorIndex = PluginRuntime.GetOptionalInt(parameters, "colorIndex");
    var gradientName = PluginRuntime.GetOptionalString(parameters, "gradient");

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var modelSpace = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, CivilObjectUtils.GetModelSpaceBlockId(database, transaction), OpenMode.ForWrite);

      var hatch = new Hatch();
      modelSpace.AppendEntity(hatch);
      transaction.AddNewlyCreatedDBObject(hatch, true);
      hatch.SetDatabaseDefaults();
      hatch.Associative = associative;

      if (!string.IsNullOrWhiteSpace(gradientName))
      {
        // Declare the gradient object type first: SetGradient silently degrades to SOLID otherwise.
        hatch.SetHatchPattern(HatchPatternType.PreDefined, "SOLID");
        hatch.HatchObjectType = HatchObjectType.GradientObject;
        try
        {
          hatch.SetGradient(GradientPatternType.PreDefinedGradient, gradientName!);
        }
        catch (Exception ex) when (ex is Autodesk.AutoCAD.Runtime.Exception or ArgumentException)
        {
          throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Invalid gradient name '{gradientName}' ({ex.Message}). Common names: LINEAR, CYLINDER, SPHERICAL, HEMISPHERICAL, CURVED.");
        }

        if (!hatch.IsGradient)
        {
          throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"The gradient did not take effect (the name may be invalid): '{gradientName}'. Common names: LINEAR, CYLINDER, SPHERICAL, HEMISPHERICAL, CURVED.");
        }

        var gradientAngle = PluginRuntime.GetOptionalDouble(parameters, "gradientAngle");
        if (gradientAngle.HasValue)
        {
          hatch.GradientAngle = gradientAngle.Value;
        }

        var gradientColors = ParseGradientColors(PluginRuntime.GetParameter(parameters, "gradientColors") as JsonNode);
        if (gradientColors != null)
        {
          hatch.GradientOneColorMode = false;
          hatch.SetGradientColors(gradientColors.ToArray());
        }
        else
        {
          hatch.GradientOneColorMode = true;
          var shadeTint = PluginRuntime.GetOptionalDouble(parameters, "shadeTint");
          if (shadeTint.HasValue)
          {
            hatch.ShadeTintValue = (float)Math.Max(0, Math.Min(1, shadeTint.Value));
          }
        }
      }
      else
      {
        hatch.SetHatchPattern(HatchPatternType.PreDefined, pattern);
        hatch.PatternScale = scale;
        hatch.PatternAngle = angle;
      }

      hatch.HatchStyle = ParseStyle(islandStyle);

      var loopCount = 0;
      if (loopsNode != null && loopsNode.Count > 0)
      {
        for (var i = 0; i < loopsNode.Count; i++)
        {
          if (!TryAddLoop(hatch, loopsNode[i], i, islandStyle, out var loopsError))
          {
            throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"loops[{i}]: {loopsError}");
          }

          loopCount++;
        }
      }
      else
      {
        if (!TryAddLoop(hatch, pointsNode, 0, islandStyle, out var pointsError))
        {
          throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"points: {pointsError}");
        }

        loopCount = 1;
      }

      // EvaluateHatch is only valid after the hatch is in the database.
      hatch.EvaluateHatch(true);

      if (!string.IsNullOrWhiteSpace(layerName))
      {
        hatch.LayerId = LookupUtils.GetLayerId(database, transaction, layerName);
      }

      if (colorIndex.HasValue)
      {
        hatch.Color = colorIndex.Value switch
        {
          256 => Color.FromColorIndex(ColorMethod.ByLayer, 256),
          0 => Color.FromColorIndex(ColorMethod.ByBlock, 0),
          _ => Color.FromColorIndex(ColorMethod.ByAci, (short)colorIndex.Value),
        };
      }

      var result = Describe(hatch);
      result["handle"] = CivilObjectUtils.GetHandle(hatch);
      result["loops"] = loopCount;
      result["ok"] = true;
      return (object?)result;
    });
  }
}
