using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace Civil3DMcpPlugin;

/// <summary>
/// P2 (implementation plan item 13) — raw shape detection: for a symbol drawn by hand with loose
/// lines and circles instead of an inserted block. This is analytic geometry only (no computer
/// vision), so the result is probabilistic, not the exactness the block actions give.
/// Ported from DaniGhosy/civil3d-mcp plugin/Civil3dMcpPlugin/ShapeDetectionCommands.cs
/// (MIT, Copyright (c) 2025 lisiting01). The donor's fourth action,
/// classify_geometry_by_signature, is pure TypeScript post-processing with no plugin method, so it
/// stays in geometryDomain.ts and is not routed here.
/// getEntityExtendedData reads DBObject.XData / GetXDataForApplication(string) — documented
/// Autodesk .NET API (Assign and Retrieve Extended Data). Reading XDATA needs no RegAppTable
/// entry; only writing a new application does.
/// </summary>
public static class ShapeDetectionCommands
{
  public static Task<object?> DetectParallelLinePairsAsync(JsonObject? parameters)
  {
    var layerFilter = PluginRuntime.GetOptionalString(parameters, "layer");
    var angleToleranceDegrees = PluginRuntime.GetOptionalDouble(parameters, "angleToleranceDegrees") ?? 2.0;
    var maxDistance = PluginRuntime.GetOptionalDouble(parameters, "maxDistance") ?? 1.0;

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var modelSpace = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, CivilObjectUtils.GetModelSpaceBlockId(database, transaction), OpenMode.ForRead);

      var lines = new List<Line>();
      foreach (ObjectId objectId in modelSpace)
      {
        if (transaction.GetObject(objectId, OpenMode.ForRead) is not Line line)
        {
          continue;
        }

        if (layerFilter != null && !string.Equals(line.Layer, layerFilter, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }

        lines.Add(line);
      }

      var angleToleranceRadians = angleToleranceDegrees * Math.PI / 180.0;
      var pairs = new List<Dictionary<string, object?>>();

      for (var i = 0; i < lines.Count; i++)
      {
        for (var j = i + 1; j < lines.Count; j++)
        {
          var first = lines[i];
          var second = lines[j];

          if (!AreAnglesParallel(LineAngle(first), LineAngle(second), angleToleranceRadians))
          {
            continue;
          }

          var distanceAtStart = PerpendicularDistance(first, second.StartPoint);
          var distanceAtEnd = PerpendicularDistance(first, second.EndPoint);
          if (distanceAtStart > maxDistance)
          {
            continue;
          }

          // A consistent distance at both ends of the second line confirms a real parallel pair
          // and not two lines that merely cross at a similar angle.
          var spread = Math.Abs(distanceAtStart - distanceAtEnd);
          if (spread > maxDistance * 0.25)
          {
            continue;
          }

          pairs.Add(new Dictionary<string, object?>
          {
            ["handleA"] = first.Handle.ToString(),
            ["handleB"] = second.Handle.ToString(),
            ["distance"] = (distanceAtStart + distanceAtEnd) / 2.0,
            ["layer"] = first.Layer,
          });
        }
      }

      return new Dictionary<string, object?>
      {
        ["layer"] = layerFilter,
        ["angleToleranceDegrees"] = angleToleranceDegrees,
        ["maxDistance"] = maxDistance,
        ["pairs"] = pairs,
      };
    });
  }

  public static Task<object?> GroupEntitiesByProximityAsync(JsonObject? parameters)
  {
    var layerFilter = PluginRuntime.GetOptionalString(parameters, "layer");
    var radius = PluginRuntime.GetRequiredDouble(parameters, "radius");

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var modelSpace = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, CivilObjectUtils.GetModelSpaceBlockId(database, transaction), OpenMode.ForRead);

      var items = new List<(ObjectId Id, Point3d Center, string ObjectType, string Layer)>();
      foreach (ObjectId objectId in modelSpace)
      {
        if (transaction.GetObject(objectId, OpenMode.ForRead) is not Entity entity)
        {
          continue;
        }

        if (layerFilter != null && !string.Equals(entity.Layer, layerFilter, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }

        try
        {
          var extents = entity.GeometricExtents;
          var center = new Point3d(
            (extents.MinPoint.X + extents.MaxPoint.X) / 2.0,
            (extents.MinPoint.Y + extents.MaxPoint.Y) / 2.0,
            0);
          items.Add((objectId, center, entity.GetType().Name, entity.Layer));
        }
        catch
        {
          // No expandable extents (some non-graphical objects) — skipped, not counted.
        }
      }

      // Simple union-find: groups by transitive adjacency (A-B nearby and B-C nearby groups
      // A, B and C even when A-C is far), which is what "one symbolic unit" needs — a symbol of
      // 3+ loose pieces does not always have every pair inside the radius.
      var parent = Enumerable.Range(0, items.Count).ToArray();
      int Find(int index) => parent[index] == index ? index : (parent[index] = Find(parent[index]));
      void Union(int left, int right)
      {
        var leftRoot = Find(left);
        var rightRoot = Find(right);
        if (leftRoot != rightRoot)
        {
          parent[leftRoot] = rightRoot;
        }
      }

      for (var i = 0; i < items.Count; i++)
      {
        for (var j = i + 1; j < items.Count; j++)
        {
          if (items[i].Center.DistanceTo(items[j].Center) <= radius)
          {
            Union(i, j);
          }
        }
      }

      var groups = items
        .Select((item, index) => (item: item, root: Find(index)))
        .GroupBy(entry => entry.root)
        .Select(group => new Dictionary<string, object?>
        {
          ["handles"] = group.Select(entry => entry.item.Id.Handle.ToString()).ToList(),
          ["entityTypes"] = group.Select(entry => entry.item.ObjectType).Distinct().ToList(),
          ["layer"] = group.First().item.Layer,
          ["center"] = new Dictionary<string, object?>
          {
            ["x"] = group.Average(entry => entry.item.Center.X),
            ["y"] = group.Average(entry => entry.item.Center.Y),
          },
        })
        .ToList();

      return new Dictionary<string, object?>
      {
        ["layer"] = layerFilter,
        ["radius"] = radius,
        ["groups"] = groups,
      };
    });
  }

  public static Task<object?> GetEntityExtendedDataAsync(JsonObject? parameters)
  {
    var handleValue = PluginRuntime.GetRequiredString(parameters, "handle");
    var appName = PluginRuntime.GetOptionalString(parameters, "appName");

    long handleNumber;
    try
    {
      handleNumber = Convert.ToInt64(handleValue, 16);
    }
    catch (Exception ex) when (ex is FormatException or OverflowException or ArgumentException)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Handle '{handleValue}' is not a valid hexadecimal handle.");
    }

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      // Database.TryGetObjectId is the framework's own resolver — no second handle-parsing helper.
      if (!database.TryGetObjectId(new Handle(handleNumber), out var objectId) || objectId.IsNull)
      {
        throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Entity with handle '{handleValue}' was not found.");
      }

      var dbObject = CivilObjectUtils.GetRequiredObject<DBObject>(transaction, objectId, OpenMode.ForRead);
      var resultBuffer = appName != null ? dbObject.GetXDataForApplication(appName) : dbObject.XData;

      if (resultBuffer == null)
      {
        return new Dictionary<string, object?>
        {
          ["handle"] = handleValue,
          ["appName"] = appName,
          ["applications"] = new List<Dictionary<string, object?>>(),
        };
      }

      var applications = new List<Dictionary<string, object?>>();
      List<Dictionary<string, object?>>? currentEntries = null;

      foreach (var typedValue in resultBuffer.AsArray())
      {
        if (typedValue.TypeCode == (int)DxfCode.ExtendedDataRegAppName)
        {
          currentEntries = new List<Dictionary<string, object?>>();
          applications.Add(new Dictionary<string, object?>
          {
            ["appName"] = typedValue.Value?.ToString(),
            ["entries"] = currentEntries,
          });
          continue;
        }

        currentEntries?.Add(new Dictionary<string, object?>
        {
          ["typeCode"] = typedValue.TypeCode,
          ["value"] = SerializeXDataValue(typedValue.Value),
        });
      }

      return new Dictionary<string, object?>
      {
        ["handle"] = handleValue,
        ["appName"] = appName,
        ["applications"] = applications,
      };
    });
  }

  // ── Helpers (private to this file) ──

  private static double LineAngle(Line line)
  {
    var delta = line.EndPoint - line.StartPoint;
    var angle = Math.Atan2(delta.Y, delta.X);
    // Normalize to [0, PI): a line and its opposite (180 degrees) are the same direction.
    if (angle < 0) angle += Math.PI;
    if (angle >= Math.PI) angle -= Math.PI;
    return angle;
  }

  private static bool AreAnglesParallel(double angleA, double angleB, double tolerance)
  {
    var difference = Math.Abs(angleA - angleB);
    difference = Math.Min(difference, Math.PI - difference);
    return difference <= tolerance;
  }

  private static double PerpendicularDistance(Line line, Point3d point)
  {
    var direction = (line.EndPoint - line.StartPoint).GetNormal();
    var toPoint = point - line.StartPoint;
    var projectionLength = toPoint.DotProduct(direction);
    var closestPoint = line.StartPoint + direction * projectionLength;
    return point.DistanceTo(closestPoint);
  }

  private static object? SerializeXDataValue(object? value)
  {
    return value switch
    {
      null => null,
      Point3d point3d => new Dictionary<string, object?> { ["x"] = point3d.X, ["y"] = point3d.Y, ["z"] = point3d.Z },
      Point2d point2d => new Dictionary<string, object?> { ["x"] = point2d.X, ["y"] = point2d.Y },
      ObjectId objectId => objectId.IsNull ? null : objectId.Handle.ToString(),
      Handle handle => handle.ToString(),
      _ => value,
    };
  }
}
