using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using AcDbObject = Autodesk.AutoCAD.DatabaseServices.DBObject;
using CivilSurface = Autodesk.Civil.DatabaseServices.Surface;

namespace Civil3DMcpPlugin;

/// <summary>
/// civil3d_object — generic introspection over ANY AutoCAD/Civil 3D object, for
/// the types no domain-specific command covers. Actions: list_types,
/// get_properties, list_properties, set_properties, find_by_property.
///
/// Two rules shape every method here.
///
/// 1. The reflection boundary. This file contains no reflection of its own.
///    Every read goes through Civil3DCompatibility.GetPropertyValue and every
///    write through Civil3DCompatibility.TrySetProperty, which are the single
///    place allowed to reflect (see Civil3DCompatibility.cs and
///    tests/reflection_boundary.test.ts).
///
/// 2. The surface guard. The donor recorded a live hang: get_properties on a
///    TinSurface blocked for 120 s, because one individual getter of that type
///    blocks when it is invoked. No per-property timeout is possible inside a
///    single-threaded document transaction, so this port never sweeps a surface.
///    Every read is a NAMED read from a curated allow-list chosen before the
///    read starts, and a surface type returns only the short list below with an
///    explicit note instead of a property sweep. The curated list exists for
///    every object type, not only for surfaces.
/// </summary>
public static class ObjectCommands
{
  private const int DefaultLimit = 200;
  private const int MaxLimit = 1000;
  private const int MaxProperties = 40;

  /// <summary>Properties every object type is asked for when it has no curated entry.</summary>
  private static readonly string[] CorePropertyNames =
  {
    "Name", "Handle", "Layer", "Description", "StyleName",
  };

  /// <summary>
  /// The only properties set_properties may write. They are the ones with a
  /// documented setter across the object families this tool serves; each write
  /// still has to succeed through Civil3DCompatibility.TrySetProperty.
  /// </summary>
  private static readonly HashSet<string> WritablePropertyNames = new(StringComparer.OrdinalIgnoreCase)
  {
    "Name", "Layer", "Description", "StyleName",
  };

  /// <summary>
  /// The short set returned for any surface type. It is the same set the fork's
  /// SurfaceCommands already reads without blocking (name, handle, layer,
  /// style), so it is known fast on TinSurface and GridSurface.
  /// </summary>
  private static readonly string[] SurfacePropertyNames =
  {
    "Name", "Handle", "Layer", "Description", "StyleName",
  };

  private const string SurfaceNote =
    "Surface objects use a curated safe property set, not a property sweep: the donor measured "
    + "120 s on get_properties for a TinSurface, because one getter of that type blocks. Read a "
    + "surface through civil3d_surface for its full detail.";

  private const string UnknownTypeNote =
    "This object type has no curated entry in civil3d_object, so only the core property names were "
    + "read. Add the type to the curated allow-list in ObjectCommands.cs before reading more of it.";

  /// <summary>
  /// Curated read list per object type, applied BEFORE any read. A name here that
  /// the type does not have costs one failed property lookup and no value; a name
  /// that is missing from the list is simply not read.
  /// </summary>
  private static readonly Dictionary<string, string[]> CuratedPropertyNames = new(StringComparer.OrdinalIgnoreCase)
  {
    ["Alignment"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "StyleName", "AlignmentType",
      "StartingStation", "EndingStation", "Length", "EntityCount",
    },
    ["Profile"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "StyleName", "ProfileType",
      "StartingStation", "EndingStation", "Length", "EntityCount",
    },
    ["ProfileView"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["Corridor"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["Assembly"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName", "AssemblyType" },
    ["Subassembly"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["Parcel"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "StyleName", "Area", "Perimeter",
    },
    ["Site"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["FeatureLine"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "StyleName", "Length",
    },
    ["Grading"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["GradingGroup"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName", "CriteriaName" },
    ["CogoPoint"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "StyleName", "PointNumber",
      "PointName", "RawDescription", "FullDescription", "Easting", "Northing", "Elevation",
    },
    ["Pipe"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "StyleName", "PartSizeName", "Length",
    },
    ["Structure"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "StyleName", "PartSizeName",
    },
    ["PipeNetwork"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["PressurePipe"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["PressurePipeNetwork"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["SampleLineGroup"] = new[] { "Name", "Handle", "Layer", "Description", "StyleName" },
    ["SampleLine"] = new[] { "Name", "Handle", "Description", "StyleName" },
    ["Section"] = new[] { "Name", "Handle", "Description", "StyleName" },
    ["SectionView"] = new[] { "Name", "Handle", "Description", "StyleName" },
    ["Line"] = new[]
    {
      "Handle", "Layer", "Description", "StartPoint", "EndPoint", "Length", "Angle",
    },
    ["Polyline"] = new[]
    {
      "Handle", "Layer", "Description", "Closed", "Length", "Area", "NumberOfVertices",
    },
    ["Polyline2d"] = new[]
    {
      "Handle", "Layer", "Description", "Closed", "Length", "Area", "NumberOfVertices",
    },
    ["Polyline3d"] = new[] { "Handle", "Layer", "Description", "Closed", "Length" },
    ["Circle"] = new[]
    {
      "Handle", "Layer", "Description", "Center", "Radius", "Diameter", "Circumference", "Area",
    },
    ["Arc"] = new[]
    {
      "Handle", "Layer", "Description", "Center", "Radius", "StartPoint", "EndPoint",
      "StartAngle", "EndAngle", "Length",
    },
    ["Ellipse"] = new[]
    {
      "Handle", "Layer", "Description", "Center", "MajorRadius", "MinorRadius", "StartAngle", "EndAngle",
    },
    ["Spline"] = new[] { "Handle", "Layer", "Description", "Closed", "NumberOfControlPoints" },
    ["DBText"] = new[]
    {
      "Handle", "Layer", "Description", "TextString", "Height", "Rotation", "Position", "StyleName",
    },
    ["MText"] = new[]
    {
      "Handle", "Layer", "Description", "Text", "Height", "Rotation", "Location", "StyleName",
    },
    ["MLeader"] = new[] { "Handle", "Layer", "Description", "StyleName" },
    ["BlockReference"] = new[]
    {
      "Name", "Handle", "Layer", "Description", "Position", "Rotation", "ScaleFactors", "BlockName",
    },
    ["Hatch"] = new[] { "Handle", "Layer", "Description", "PatternName", "Area", "NumberOfLoops" },
    ["Point"] = new[] { "Handle", "Layer", "Description", "Position" },
    ["Solid"] = new[] { "Handle", "Layer", "Description" },
    ["Region"] = new[] { "Handle", "Layer", "Description", "Area" },
  };

  /// <summary>
  /// The plane AutoCAD entity types whose scalar properties the compatibility
  /// boundary may enumerate. A surface type is never in this set, and a Civil 3D
  /// object is never in it either, so list_properties can enrich a Line or a
  /// BlockReference without ever pointing an enumeration at TinSurface.
  /// </summary>
  private static readonly HashSet<string> ScalarEnumerableTypeNames = new(StringComparer.Ordinal)
  {
    "Line", "Polyline", "Polyline2d", "Polyline3d", "Circle", "Arc", "Ellipse", "Spline",
    "DBText", "MText", "MLeader", "BlockReference", "Hatch", "Point", "Solid", "Region",
  };

  // ─────────────────────────────────────────────
  // list_types — the donor's search-by-type (optionally one layer), plus the
  // type inventory of whatever matched.
  // ─────────────────────────────────────────────

  public static Task<object?> ListObjectTypesAsync(JsonObject? parameters)
  {
    var contains = PluginRuntime.GetOptionalString(parameters, "contains");
    var objectType = PluginRuntime.GetOptionalString(parameters, "objectType");
    var layer = PluginRuntime.GetOptionalString(parameters, "layer");
    var limit = ClampLimit(PluginRuntime.GetOptionalInt(parameters, "limit"));

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var counts = new Dictionary<string, int>(StringComparer.Ordinal);
      var objects = new List<object>();
      var total = 0;

      foreach (var objectId in EnumerateDrawingObjects(civilDoc, database, transaction))
      {
        var dbObject = transaction.GetObject(objectId, OpenMode.ForRead);
        if (dbObject == null)
        {
          continue;
        }

        var currentType = dbObject.GetType().Name;
        if (!string.IsNullOrWhiteSpace(contains)
          && currentType.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0)
        {
          continue;
        }

        if (!string.IsNullOrWhiteSpace(objectType) && !MatchesTypeName(dbObject, objectType))
        {
          continue;
        }

        var currentLayer = CivilObjectUtils.GetStringProperty(dbObject, "Layer");
        if (!string.IsNullOrWhiteSpace(layer)
          && !string.Equals(currentLayer, layer, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }

        total++;
        counts[currentType] = counts.TryGetValue(currentType, out var count) ? count + 1 : 1;

        if (objects.Count >= limit)
        {
          continue;
        }

        objects.Add(new Dictionary<string, object?>
        {
          ["handle"] = CivilObjectUtils.GetHandle(dbObject),
          ["objectType"] = currentType,
          ["name"] = CivilObjectUtils.GetName(dbObject),
          ["layer"] = currentLayer,
        });
      }

      var types = counts
        .OrderByDescending(entry => entry.Value)
        .ThenBy(entry => entry.Key, StringComparer.Ordinal)
        .Take(limit)
        .Select(entry => (object)new Dictionary<string, object?>
        {
          ["objectType"] = entry.Key,
          ["count"] = entry.Value,
        })
        .ToList();

      return new Dictionary<string, object?>
      {
        ["contains"] = contains,
        ["objectType"] = objectType,
        ["layer"] = layer,
        ["total"] = total,
        ["typeCount"] = counts.Count,
        ["truncated"] = total > objects.Count,
        ["typesTruncated"] = counts.Count > types.Count,
        ["types"] = types,
        ["objects"] = objects,
      };
    });
  }

  // ─────────────────────────────────────────────
  // get_properties — the curated property VALUES of one object.
  // ─────────────────────────────────────────────

  public static Task<object?> GetObjectPropertiesAsync(JsonObject? parameters)
  {
    var handleValue = PluginRuntime.GetRequiredString(parameters, "handle");
    _ = ParseHandleNumber(handleValue);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var dbObject = OpenByHandle(transaction, database, handleValue, OpenMode.ForRead);
      var objectType = dbObject.GetType().Name;
      var surface = IsSurfaceObject(dbObject, objectType);
      var propertyNames = PropertyNamesFor(dbObject, objectType, includeEnumerated: false);

      return new Dictionary<string, object?>
      {
        ["handle"] = handleValue,
        ["objectType"] = objectType,
        ["layer"] = CivilObjectUtils.GetStringProperty(dbObject, "Layer"),
        ["isSurface"] = surface,
        ["curated"] = true,
        ["checkedPropertyCount"] = propertyNames.Count,
        ["properties"] = ReadProperties(dbObject, propertyNames),
        ["note"] = BuildNote(objectType, surface, propertyNames),
      };
    });
  }

  // ─────────────────────────────────────────────
  // list_properties — the curated property NAMES of one object, with no values.
  // ─────────────────────────────────────────────

  public static Task<object?> ListObjectPropertyNamesAsync(JsonObject? parameters)
  {
    var handleValue = PluginRuntime.GetRequiredString(parameters, "handle");
    _ = ParseHandleNumber(handleValue);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var dbObject = OpenByHandle(transaction, database, handleValue, OpenMode.ForRead);
      var objectType = dbObject.GetType().Name;
      var surface = IsSurfaceObject(dbObject, objectType);
      var propertyNames = PropertyNamesFor(dbObject, objectType, includeEnumerated: true);

      var properties = propertyNames
        .Select(propertyName => (object)new Dictionary<string, object?>
        {
          ["name"] = propertyName,
          ["present"] = Civil3DCompatibility.GetPropertyValue(dbObject, propertyName) != null,
          ["writable"] = WritablePropertyNames.Contains(propertyName),
        })
        .ToList();

      return new Dictionary<string, object?>
      {
        ["handle"] = handleValue,
        ["objectType"] = objectType,
        ["isSurface"] = surface,
        ["curated"] = true,
        ["propertyCount"] = properties.Count,
        ["properties"] = properties,
        ["note"] = BuildNote(objectType, surface, propertyNames),
      };
    });
  }

  // ─────────────────────────────────────────────
  // set_properties — write the curated writable properties of one object.
  // ─────────────────────────────────────────────

  public static Task<object?> SetObjectPropertiesAsync(JsonObject? parameters)
  {
    var handleValue = PluginRuntime.GetRequiredString(parameters, "handle");
    var propertiesNode = PluginRuntime.GetParameter(parameters, "properties") as JsonObject
      ?? throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        "set_properties requires a 'properties' object, for example { \"StyleName\": \"Proposed\" }.");

    if (propertiesNode.Count == 0)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "set_properties requires at least one property.");
    }

    _ = ParseHandleNumber(handleValue);

    // Every name and value is checked BEFORE the first write, so a refused
    // write cannot leave a half-applied change behind.
    var writableNames = string.Join(", ", WritablePropertyNames.OrderBy(name => name, StringComparer.Ordinal));
    var requests = new List<KeyValuePair<string, object?>>();
    foreach (var entry in propertiesNode)
    {
      if (!WritablePropertyNames.Contains(entry.Key))
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.INVALID_INPUT",
          $"Property '{entry.Key}' cannot be set through civil3d_object. Writable properties: {writableNames}.");
      }

      // A JSON null, array or object is not a property value, and writing null
      // into a string property would leave the object in a state AutoCAD rejects.
      if (entry.Value is not JsonValue)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.INVALID_INPUT",
          $"Property '{entry.Key}' must be a string, a number or a boolean.");
      }

      requests.Add(new KeyValuePair<string, object?>(entry.Key, ToClrValue(entry.Value)));
    }

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var dbObject = OpenByHandle(transaction, database, handleValue, OpenMode.ForWrite);
      var applied = new List<object>();

      foreach (var request in requests)
      {
        if (!Civil3DCompatibility.TrySetProperty(dbObject, request.Key, request.Value))
        {
          throw new JsonRpcDispatchException(
            "CIVIL3D.INVALID_INPUT",
            $"Property '{request.Key}' is not writable on object type '{dbObject.GetType().Name}'. "
            + "Nothing was changed.");
        }

        applied.Add(new Dictionary<string, object?>
        {
          ["name"] = request.Key,
          ["value"] = ToSerializableValue(Civil3DCompatibility.GetPropertyValue(dbObject, request.Key)),
        });
      }

      return new Dictionary<string, object?>
      {
        ["handle"] = handleValue,
        ["objectType"] = dbObject.GetType().Name,
        ["applied"] = applied,
      };
    });
  }

  // ─────────────────────────────────────────────
  // find_by_property — the donor's search-by-type, plus one property predicate.
  // ─────────────────────────────────────────────

  public static Task<object?> FindObjectsByPropertyAsync(JsonObject? parameters)
  {
    var propertyName = PluginRuntime.GetRequiredString(parameters, "property");
    var expected = PluginRuntime.GetRequiredString(parameters, "value");
    var objectType = PluginRuntime.GetOptionalString(parameters, "objectType");
    var layer = PluginRuntime.GetOptionalString(parameters, "layer");
    var limit = ClampLimit(PluginRuntime.GetOptionalInt(parameters, "limit"));

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var matches = new List<object>();
      var total = 0;
      var scanned = 0;

      foreach (var objectId in EnumerateDrawingObjects(civilDoc, database, transaction))
      {
        var dbObject = transaction.GetObject(objectId, OpenMode.ForRead);
        if (dbObject == null)
        {
          continue;
        }

        var currentType = dbObject.GetType().Name;
        if (!string.IsNullOrWhiteSpace(objectType) && !MatchesTypeName(dbObject, objectType))
        {
          continue;
        }

        var currentLayer = CivilObjectUtils.GetStringProperty(dbObject, "Layer");
        if (!string.IsNullOrWhiteSpace(layer)
          && !string.Equals(currentLayer, layer, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }

        // The surface guard applies here too: a surface is only asked for the
        // properties the curated short list already proved fast.
        if (IsSurfaceObject(dbObject, currentType)
          && !SurfacePropertyNames.Contains(propertyName, StringComparer.OrdinalIgnoreCase))
        {
          continue;
        }

        scanned++;
        var raw = Civil3DCompatibility.GetPropertyValue(dbObject, propertyName);
        if (raw == null)
        {
          continue;
        }

        var actual = Convert.ToString(ToSerializableValue(raw), CultureInfo.InvariantCulture);
        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
        {
          continue;
        }

        total++;
        if (matches.Count >= limit)
        {
          continue;
        }

        matches.Add(new Dictionary<string, object?>
        {
          ["handle"] = CivilObjectUtils.GetHandle(dbObject),
          ["objectType"] = currentType,
          ["name"] = CivilObjectUtils.GetName(dbObject),
          ["layer"] = currentLayer,
          ["propertyValue"] = ToSerializableValue(raw),
        });
      }

      return new Dictionary<string, object?>
      {
        ["property"] = propertyName,
        ["value"] = expected,
        ["objectType"] = objectType,
        ["layer"] = layer,
        ["scanned"] = scanned,
        ["total"] = total,
        ["truncated"] = total > matches.Count,
        ["objects"] = matches,
      };
    });
  }

  // ── Object enumeration ──

  /// <summary>
  /// Every object this tool can consider: model-space entities (which is what the
  /// donor searched, and where label entities live) plus the Civil 3D collections
  /// that no model-space walk can reach. Only API calls already used elsewhere in
  /// this plugin appear here.
  /// </summary>
  private static IEnumerable<ObjectId> EnumerateDrawingObjects(
    CivilDocument civilDoc,
    Database database,
    Transaction transaction)
  {
    var seen = new HashSet<ObjectId>();

    var blockTable = CivilObjectUtils.GetRequiredObject<BlockTable>(
      transaction, database.BlockTableId, OpenMode.ForRead);
    var modelSpace = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(
      transaction, blockTable[BlockTableRecord.ModelSpace], OpenMode.ForRead);
    foreach (ObjectId objectId in modelSpace)
    {
      if (seen.Add(objectId))
      {
        yield return objectId;
      }
    }

    foreach (ObjectId objectId in civilDoc.GetSurfaceIds())
    {
      if (seen.Add(objectId))
      {
        yield return objectId;
      }
    }

    foreach (ObjectId alignmentId in civilDoc.GetAlignmentIds())
    {
      if (seen.Add(alignmentId))
      {
        yield return alignmentId;
      }

      if (transaction.GetObject(alignmentId, OpenMode.ForRead) is not Alignment alignment)
      {
        continue;
      }

      foreach (ObjectId profileId in alignment.GetProfileIds())
      {
        if (seen.Add(profileId))
        {
          yield return profileId;
        }
      }
    }

    foreach (ObjectId objectId in civilDoc.CorridorCollection)
    {
      if (seen.Add(objectId))
      {
        yield return objectId;
      }
    }

    foreach (ObjectId objectId in civilDoc.AssemblyCollection)
    {
      if (seen.Add(objectId))
      {
        yield return objectId;
      }
    }

    foreach (ObjectId objectId in civilDoc.CogoPoints)
    {
      if (seen.Add(objectId))
      {
        yield return objectId;
      }
    }

    foreach (ObjectId siteId in civilDoc.GetSiteIds())
    {
      if (seen.Add(siteId))
      {
        yield return siteId;
      }

      if (transaction.GetObject(siteId, OpenMode.ForRead) is not Site site)
      {
        continue;
      }

      foreach (ObjectId parcelId in site.GetParcelIds())
      {
        if (seen.Add(parcelId))
        {
          yield return parcelId;
        }
      }
    }

    foreach (ObjectId objectId in civilDoc.GetPipeNetworkIds())
    {
      if (seen.Add(objectId))
      {
        yield return objectId;
      }
    }
  }

  // ── The curated allow-list ──

  /// <summary>
  /// The property names to read for one object, decided BEFORE any read. A
  /// surface object always gets the short curated set. Any other type gets its
  /// curated entry, or the core names when it has none. Only for the plain
  /// AutoCAD entity types in <see cref="ScalarEnumerableTypeNames"/> may the
  /// compatibility boundary's scalar enumeration add names, and only when the
  /// caller asked for names (the value reader never enumerates).
  /// </summary>
  private static List<string> PropertyNamesFor(AcDbObject dbObject, string objectType, bool includeEnumerated)
  {
    if (IsSurfaceObject(dbObject, objectType))
    {
      return new List<string>(SurfacePropertyNames);
    }

    var names = CuratedPropertyNames.TryGetValue(objectType, out var curated)
      ? new List<string>(curated)
      : new List<string>(CorePropertyNames);

    if (!includeEnumerated || !ScalarEnumerableTypeNames.Contains(objectType))
    {
      return names;
    }

    foreach (var property in Civil3DCompatibility.GetReadableScalarProperties(dbObject))
    {
      if (!names.Contains(property.Key, StringComparer.OrdinalIgnoreCase))
      {
        names.Add(property.Key);
      }

      if (names.Count >= MaxProperties)
      {
        break;
      }
    }

    return names;
  }

  private static Dictionary<string, object?> ReadProperties(AcDbObject dbObject, List<string> propertyNames)
  {
    var values = new Dictionary<string, object?>(StringComparer.Ordinal);
    foreach (var propertyName in propertyNames)
    {
      // A getter that returns null or refuses to run is left out rather than
      // reported as a value.
      var raw = Civil3DCompatibility.GetPropertyValue(dbObject, propertyName);
      if (raw == null)
      {
        continue;
      }

      values[propertyName] = ToSerializableValue(raw);
    }

    return values;
  }

  private static string BuildNote(string objectType, bool isSurface, List<string> propertyNames)
  {
    if (isSurface)
    {
      return SurfaceNote;
    }

    return CuratedPropertyNames.ContainsKey(objectType)
      ? $"Curated property set for '{objectType}' ({propertyNames.Count} names); no property sweep ran."
      : UnknownTypeNote;
  }

  /// <summary>
  /// True for every Civil 3D surface type, by CLR type and by type name. The
  /// name test is deliberate: a surface-derived type this list has never seen
  /// still cannot be swept.
  /// </summary>
  private static bool IsSurfaceObject(AcDbObject dbObject, string objectType)
  {
    return dbObject is CivilSurface
      || objectType.IndexOf("Surface", StringComparison.OrdinalIgnoreCase) >= 0;
  }

  /// <summary>Walks the base-type chain, so a request for "Curve" also matches "Line".</summary>
  private static bool MatchesTypeName(object value, string requestedTypeName)
  {
    for (Type? type = value.GetType(); type != null; type = type.BaseType)
    {
      if (string.Equals(type.Name, requestedTypeName, StringComparison.OrdinalIgnoreCase))
      {
        return true;
      }
    }

    return false;
  }

  // ── Handles and values ──

  private static AcDbObject OpenByHandle(
    Transaction transaction,
    Database database,
    string handleValue,
    OpenMode openMode)
  {
    var objectId = CivilObjectUtils.ResolveHandle(transaction, database, handleValue)
      ?? throw new JsonRpcDispatchException(
        "CIVIL3D.OBJECT_NOT_FOUND",
        $"Object with handle '{handleValue}' was not found.");

    return CivilObjectUtils.GetRequiredObject<AcDbObject>(transaction, objectId, openMode);
  }

  /// <summary>
  /// Keeps the fork's hexadecimal error contract for this tool: a malformed
  /// handle is INVALID_INPUT, a handle the drawing never had is OBJECT_NOT_FOUND.
  /// </summary>
  private static long ParseHandleNumber(string handleText)
  {
    try
    {
      return Convert.ToInt64(handleText, 16);
    }
    catch (Exception ex) when (ex is FormatException or OverflowException)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"Handle '{handleText}' is not a valid hexadecimal handle.");
    }
  }

  private static int ClampLimit(int? requested)
  {
    var limit = requested ?? DefaultLimit;
    if (limit < 1)
    {
      return 1;
    }

    return limit > MaxLimit ? MaxLimit : limit;
  }

  private static object? ToClrValue(JsonNode? node)
  {
    if (node is not JsonValue value)
    {
      return null;
    }

    if (value.TryGetValue<bool>(out var flag))
    {
      return flag;
    }

    if (value.TryGetValue<long>(out var integer))
    {
      return integer;
    }

    if (value.TryGetValue<double>(out var number))
    {
      return number;
    }

    return value.TryGetValue<string>(out var text) ? text : null;
  }

  /// <summary>
  /// Converts one property value to a JSON-safe shape without any reflection of
  /// its own. A value this method does not understand is reported as a type
  /// marker, never as a guessed number or string.
  /// </summary>
  private static object? ToSerializableValue(object? raw)
  {
    switch (raw)
    {
      case null:
        return null;
      case string text:
        return text;
      case bool flag:
        return flag;
      case int or long or short or byte or sbyte or uint or ushort or ulong:
        return Convert.ToInt64(raw, CultureInfo.InvariantCulture);
      case double or float or decimal:
        return Convert.ToDouble(raw, CultureInfo.InvariantCulture);
      case Enum enumeration:
        return enumeration.ToString();
      case Guid guid:
        return guid.ToString();
      case DateTime date:
        return date.ToString("o", CultureInfo.InvariantCulture);
      case Handle handle:
        return handle.ToString();
      case ObjectId objectId:
        return DescribeObjectId(objectId);
      case Point3d point:
        return new Dictionary<string, object?>
        {
          ["x"] = point.X,
          ["y"] = point.Y,
          ["z"] = point.Z,
        };
      case Point2d point:
        return new Dictionary<string, object?>
        {
          ["x"] = point.X,
          ["y"] = point.Y,
        };
      default:
        return $"<{raw.GetType().Name}>";
    }
  }

  private static string? DescribeObjectId(ObjectId objectId)
  {
    if (objectId.IsNull)
    {
      return null;
    }

    try
    {
      return objectId.Handle.ToString();
    }
    catch
    {
      // An erased or proxy object has no readable handle. Report nothing rather
      // than a wrong handle.
      return null;
    }
  }
}
