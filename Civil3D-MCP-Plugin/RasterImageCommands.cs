using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using AcRuntimeException = Autodesk.AutoCAD.Runtime.Exception;

namespace Civil3DMcpPlugin;

/// <summary>
/// Attach a raster image into the active drawing: the headless equivalent of
/// IMAGEATTACH. The image definition lives in the database's image dictionary
/// (keyed by the file name), and a <see cref="RasterImage"/> entity in the
/// current space references it.
///
/// The caller path passes FileBoundary.ResolveImportPath (canonicalized, inside
/// CIVIL3D_IMPORT_ROOTS, image extension allow-list, must exist, no
/// reparse-point traversal).
///
/// Image size, insertion point, width and aspect ratio follow the donor
/// (KevinGriffin/new_civil3d_mcp, MIT, Copyright (c) 2026 Kevin Griffin):
/// the pixel dimensions come from RasterImageDef.Size, the placed height keeps
/// the source aspect ratio, and RasterImage.EnableReactors plus
/// AssociateRasterDef wire the definition to the entity so the image displays
/// and the definition is not purgeable.
/// </summary>
public static class RasterImageCommands
{
  /// <summary>Extensions IMAGEATTACH itself accepts and the .NET raster loader can read here.</summary>
  private static readonly string[] AllowedExtensions = { ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp" };

  private const double DefaultWidth = 100.0;
  private const double DegreesToRadians = Math.PI / 180.0;

  public static Task<object?> AttachRasterImageAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var path = FileBoundary.ResolveImportPath(rawPath, AllowedExtensions);

    var width = PluginRuntime.GetOptionalDouble(parameters, "width") ?? DefaultWidth;
    if (width <= 0)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "width must be greater than zero.");
    }

    var rotationDegrees = PluginRuntime.GetOptionalDouble(parameters, "rotationDegrees") ?? 0.0;
    var insertionPoint = ParseInsertionPoint(parameters);
    var layerName = PluginRuntime.GetOptionalString(parameters, "layer");

    var definitionKey = SymbolUtilityServices.RepairSymbolName(
      Path.GetFileNameWithoutExtension(path), false);
    if (string.IsNullOrWhiteSpace(definitionKey))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"'{Path.GetFileName(path)}' does not yield a usable image definition name.");
    }

    return CivilExecution.WriteAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      // The image dictionary is database level, so create it once if missing.
      var dictionaryId = RasterImageDef.GetImageDictionary(database);
      if (dictionaryId.IsNull)
      {
        dictionaryId = RasterImageDef.CreateImageDictionary(database);
      }

      var dictionary = CivilObjectUtils.GetRequiredObject<DBDictionary>(transaction, dictionaryId, OpenMode.ForWrite);

      ObjectId definitionId;
      RasterImageDef definition;
      if (dictionary.Contains(definitionKey))
      {
        definitionId = dictionary.GetAt(definitionKey);
        definition = CivilObjectUtils.GetRequiredObject<RasterImageDef>(transaction, definitionId, OpenMode.ForWrite);
        definition.Load();
      }
      else
      {
        definition = new RasterImageDef();
        definition.SourceFileName = path;
        try
        {
          definition.Load();
        }
        catch (AcRuntimeException exception)
        {
          // The definition was never added to the dictionary, so it is not
          // owned by the transaction yet.
          throw new JsonRpcDispatchException(
            "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
            $"Civil 3D could not read the raster image '{path}': {exception.Message}");
        }

        definitionId = dictionary.SetAt(definitionKey, definition);
        transaction.AddNewlyCreatedDBObject(definition, true);
      }

      // Keep the source aspect ratio: Size is the pixel size of the loaded image.
      var pixelSize = definition.Size;
      var aspectRatio = pixelSize.X > 0 ? pixelSize.Y / pixelSize.X : 1.0;
      var height = width * aspectRatio;

      var radians = rotationDegrees * DegreesToRadians;
      var cosine = Math.Cos(radians);
      var sine = Math.Sin(radians);
      var u = new Vector3d(cosine * width, sine * width, 0.0);    // along the bottom edge
      var v = new Vector3d(-sine * height, cosine * height, 0.0); // along the left edge

      var image = new RasterImage();
      try
      {
        image.ImageDefId = definitionId;
        image.Orientation = new CoordinateSystem3d(insertionPoint, u, v);
        image.ShowImage = true;

        if (!string.IsNullOrWhiteSpace(layerName))
        {
          image.LayerId = LookupUtils.GetLayerId(database, transaction, layerName);
        }

        var space = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, database.CurrentSpaceId, OpenMode.ForWrite);
        var imageId = space.AppendEntity(image);
        transaction.AddNewlyCreatedDBObject(image, true);

        // Without the definition reactor the image does not display and the
        // definition becomes purgeable; this wires the two together.
        RasterImage.EnableReactors(true);
        image.AssociateRasterDef(definition);

        // Read the entity back while the transaction is open.
        var placed = CivilObjectUtils.GetRequiredObject<RasterImage>(transaction, imageId, OpenMode.ForRead);

        return (object?)new Dictionary<string, object?>
        {
          ["path"] = path,
          ["imageDef"] = definitionKey,
          ["handle"] = CivilObjectUtils.GetHandle(placed),
          ["widthPixels"] = pixelSize.X,
          ["heightPixels"] = pixelSize.Y,
          ["width"] = width,
          ["height"] = height,
          ["insertionPoint"] = new Dictionary<string, object?>
          {
            ["x"] = insertionPoint.X,
            ["y"] = insertionPoint.Y,
            ["z"] = insertionPoint.Z,
          },
          ["rotationDegrees"] = rotationDegrees,
          ["layer"] = placed.Layer,
          ["notes"] = new List<string>
          {
            "The image keeps the source aspect ratio; height is derived from widthPixels/heightPixels.",
            "The insertion point is the lower-left corner of the image.",
            "The image is placed in the current space (model or the active paper space).",
          },
        };
      }
      catch
      {
        image.Dispose();
        throw;
      }
    });
  }

  private static Point3d ParseInsertionPoint(JsonObject? parameters)
  {
    if (PluginRuntime.GetParameter(parameters, "insertionPoint") is not JsonObject point)
    {
      return Point3d.Origin;
    }

    var x = point["x"]?.GetValue<double>()
      ?? throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "insertionPoint is missing x.");
    var y = point["y"]?.GetValue<double>()
      ?? throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "insertionPoint is missing y.");
    var z = point["z"]?.GetValue<double>() ?? 0d;
    return new Point3d(x, y, z);
  }
}
