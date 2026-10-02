using System.Globalization;
using System.Text.Json.Nodes;

namespace Civil3DMcpPlugin;

/// <summary>
/// Civil 3D field-book (.fbk) parser -- item 2 of the P4 port, ported from the donor
/// KevinGriffin/new_civil3d_mcp (MIT), plugin/Civil3dMcpBridge.cs:
/// <c>ParseFbkFile</c>, <c>ParseFbkLine</c> and <c>DmsPackedToRadians</c>.
///
/// SCOPE: THE PARSER ONLY. The donor's FBK import drives the AutoCAD
/// <c>IMPORTFIELDBOOK</c> command and the Survey COM API (AeccSurveyProject /
/// AeccSurveyNetwork / Setup.Observations), which are version-pinned to Civil 3D 2026 (v13.8)
/// through two Interop assemblies this fork does not reference. No import command exists here, no
/// Interop reference was added, and no COM object is touched: <see cref="ParseFbkAsync"/> reads one
/// file and returns data. It changes no drawing.
///
/// The caller-supplied file passes <see cref="FileBoundary.ResolveImportPath"/> (import roots,
/// <c>.fbk</c> only, must exist) before System.IO sees it -- the same boundary every other import
/// command in this plugin uses.
///
/// Supported record subset (the FieldGenius subset the donor parses):
///   JOB                                -- job header, kept as a record
///   UNIT / EDM / SCALE / HORIZ / VERT  -- ignored header noise
///   !                                  -- comment, skipped
///   NEZ   pt n e z "desc"              -- coordinate point (Northing, Easting, Elevation)
///   STN   pt hi "desc"                 -- station setup
///   BS    pt circle                    -- backsight point and circle reading
///   AZ    from to dms                  -- azimuth
///   PRISM height                       -- target height, sticky until changed
///   F1 / F2 [VA|ZA|ZE] pt ha sd va "desc" -- observation (face 1 / face 2)
///
/// Angles are DMS-packed as DDD.MMSSsss: the integer part is degrees, the first two decimals are
/// minutes, the next two are seconds and the rest are fractional seconds. For example 86.43340 is
/// 86 degrees 43 minutes 34.0 seconds. The packed value is reported as written and the decimal
/// degrees are reported beside it (<c>azimuthDegrees</c>, <c>haDegrees</c>, <c>vaDegrees</c>,
/// <c>backsightCircleDegrees</c>).
///
/// Figures are NOT parsed: the donor parser has no figure keyword and its parse result has no
/// figure collection, so there is no figure grammar to port. Nothing is offered for figures.
/// </summary>
public static class FbkCommands
{
  private enum FbkRecordType
  {
    Nez,
    Stn,
    Bs,
    Az,
    Prism,
    F1,
    F2,
    Job,
    Ignored,
    Unknown,
  }

  private sealed class FbkRecord
  {
    public int LineNumber;
    public FbkRecordType Type;
    public int? PointNumber;
    public double? N;
    public double? E;
    public double? Z;
    public double? InstrumentHeight;
    public double? Circle;
    public double? AzimuthDms;
    public int? AzFrom;
    public int? AzTo;
    public double? PrismHeight;
    public string? AngleFlavor;
    public double? Ha;
    public double? Sd;
    public double? Va;
    public string? Description;
    public string? Warning;
  }

  private sealed class FbkSetupBlock
  {
    public int StationPoint;
    public double InstrumentHeight;
    public string? Description;
    public int? BacksightPoint;
    public double? BacksightCircleDms;
    public double? AzimuthDms;
    public int? AzFrom;
    public int? AzTo;
    public List<FbkRecord> Observations = new();
  }

  private sealed class FbkParseResult
  {
    public string FilePath = string.Empty;
    public int TotalLines;
    public List<FbkRecord> Records = new();
    public List<FbkRecord> ControlPoints = new();
    public List<FbkSetupBlock> Setups = new();
    public List<string> Warnings = new();
  }

  /// <summary>
  /// Parse a field book file and return the records, the inferred setups and the derived angles.
  /// Resolves the caller's path through <see cref="FileBoundary.ResolveImportPath"/> first.
  /// </summary>
  public static Task<object?> ParseFbkAsync(JsonObject? parameters)
  {
    var filePath = FileBoundary.ResolveImportPath(
      PluginRuntime.GetRequiredString(parameters, "filePath"),
      ".fbk");

    return Task.FromResult<object?>(ParseFbkFile(filePath));
  }

  /// <summary>
  /// DMS-packed angle (DDD.MMSSsss) as decimal degrees, with the sign preserved.
  /// </summary>
  private static double DmsPackedToDegrees(double packed)
  {
    var sign = packed < 0 ? -1.0 : 1.0;
    var abs = Math.Abs(packed);
    var degrees = (int)Math.Floor(abs);
    var rest = (abs - degrees) * 100.0;      // MM.SSsss
    var minutes = (int)Math.Floor(rest + 1e-9);
    var seconds = (rest - minutes) * 100.0;  // SS.sss
    return sign * (degrees + minutes / 60.0 + seconds / 3600.0);
  }

  private static double? DmsPackedToDegrees(double? packed) =>
    packed.HasValue ? DmsPackedToDegrees(packed.Value) : null;

  /// <summary>
  /// Parse one field-book line. Returns null for a blank or comment line.
  /// </summary>
  private static FbkRecord? ParseFbkLine(string line, int lineNumber)
  {
    if (string.IsNullOrWhiteSpace(line)) return null;
    var trimmed = line.TrimStart();
    if (trimmed.StartsWith("!", StringComparison.Ordinal)) return null;  // comment

    // Pull the trailing quoted description out first, so the remaining tokens are positional only.
    string? quoted = null;
    var body = trimmed;
    var firstQuote = trimmed.IndexOf('"');
    if (firstQuote >= 0)
    {
      var secondQuote = trimmed.IndexOf('"', firstQuote + 1);
      if (secondQuote > firstQuote)
      {
        quoted = trimmed.Substring(firstQuote + 1, secondQuote - firstQuote - 1);
        body = (trimmed.Substring(0, firstQuote) + " " + trimmed.Substring(secondQuote + 1)).Trim();
      }
    }

    var tokens = body.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
    if (tokens.Length == 0) return null;

    var record = new FbkRecord
    {
      LineNumber = lineNumber,
      Description = quoted,
      Type = FbkRecordType.Unknown,
    };

    var keyword = tokens[0].ToUpperInvariant();
    try
    {
      switch (keyword)
      {
        case "JOB":
          record.Type = FbkRecordType.Job;
          break;

        case "UNIT":
        case "EDM":
        case "SCALE":
        case "HORIZ":
        case "VERT":
          record.Type = FbkRecordType.Ignored;
          break;

        case "NEZ":
          // NEZ pt N E Z
          record.Type = FbkRecordType.Nez;
          record.PointNumber = int.Parse(tokens[1], CultureInfo.InvariantCulture);
          record.N = double.Parse(tokens[2], CultureInfo.InvariantCulture);
          record.E = double.Parse(tokens[3], CultureInfo.InvariantCulture);
          record.Z = double.Parse(tokens[4], CultureInfo.InvariantCulture);
          break;

        case "STN":
          // STN pt HI ["desc"]
          record.Type = FbkRecordType.Stn;
          record.PointNumber = int.Parse(tokens[1], CultureInfo.InvariantCulture);
          record.InstrumentHeight = tokens.Length > 2
            ? double.Parse(tokens[2], CultureInfo.InvariantCulture)
            : 0.0;
          break;

        case "BS":
          // BS pt [circle]
          record.Type = FbkRecordType.Bs;
          record.PointNumber = int.Parse(tokens[1], CultureInfo.InvariantCulture);
          record.Circle = tokens.Length > 2
            ? double.Parse(tokens[2], CultureInfo.InvariantCulture)
            : 0.0;
          break;

        case "AZ":
          // AZ from to dms
          record.Type = FbkRecordType.Az;
          record.AzFrom = int.Parse(tokens[1], CultureInfo.InvariantCulture);
          record.AzTo = int.Parse(tokens[2], CultureInfo.InvariantCulture);
          record.AzimuthDms = double.Parse(tokens[3], CultureInfo.InvariantCulture);
          break;

        case "PRISM":
          // PRISM height
          record.Type = FbkRecordType.Prism;
          record.PrismHeight = double.Parse(tokens[1], CultureInfo.InvariantCulture);
          break;

        case "F1":
        case "F2":
          // F1 [VA|ZA|ZE] pt ha sd va
          record.Type = keyword == "F1" ? FbkRecordType.F1 : FbkRecordType.F2;
          var index = 1;
          if (tokens.Length > 1 && IsAngleFlavor(tokens[1]))
          {
            record.AngleFlavor = tokens[1].ToUpperInvariant();
            index = 2;
          }
          record.PointNumber = int.Parse(tokens[index++], CultureInfo.InvariantCulture);
          record.Ha = double.Parse(tokens[index++], CultureInfo.InvariantCulture);
          record.Sd = double.Parse(tokens[index++], CultureInfo.InvariantCulture);
          record.Va = double.Parse(tokens[index++], CultureInfo.InvariantCulture);
          break;

        default:
          record.Type = FbkRecordType.Unknown;
          record.Warning = $"Unrecognized keyword: {keyword}";
          break;
      }
    }
    catch (Exception exception)
    {
      record.Warning = $"Parse error ({keyword}): {exception.Message}";
    }

    return record;
  }

  private static bool IsAngleFlavor(string token) =>
    token.Equals("VA", StringComparison.OrdinalIgnoreCase)
    || token.Equals("ZA", StringComparison.OrdinalIgnoreCase)
    || token.Equals("ZE", StringComparison.OrdinalIgnoreCase);

  /// <summary>
  /// Parse a whole field book into records and inferred setups. Pure: no COM call, no drawing.
  /// </summary>
  private static Dictionary<string, object?> ParseFbkFile(string fbkPath)
  {
    var result = ParseFbkResult(fbkPath);

    var records = new List<object?>(result.Records.Count);
    foreach (var record in result.Records)
    {
      records.Add(ProjectRecord(record));
    }

    var setups = new List<object?>(result.Setups.Count);
    var observationCount = 0;
    foreach (var setup in result.Setups)
    {
      observationCount += setup.Observations.Count;
      setups.Add(new Dictionary<string, object?>
      {
        ["stationPt"] = setup.StationPoint,
        ["instrumentHeight"] = setup.InstrumentHeight,
        ["description"] = setup.Description,
        ["backsightPt"] = setup.BacksightPoint,
        ["backsightCircleDms"] = setup.BacksightCircleDms,
        ["backsightCircleDegrees"] = DmsPackedToDegrees(setup.BacksightCircleDms),
        ["azimuthDms"] = setup.AzimuthDms,
        ["azimuthDegrees"] = DmsPackedToDegrees(setup.AzimuthDms),
        ["azFrom"] = setup.AzFrom,
        ["azTo"] = setup.AzTo,
        ["observationCount"] = setup.Observations.Count,
        ["observationLines"] = setup.Observations.ConvertAll(observation => observation.LineNumber),
      });
    }

    var controlPoints = new List<object?>(result.ControlPoints.Count);
    foreach (var point in result.ControlPoints)
    {
      controlPoints.Add(new Dictionary<string, object?>
      {
        ["pt"] = point.PointNumber,
        ["n"] = point.N,
        ["e"] = point.E,
        ["z"] = point.Z,
        ["desc"] = point.Description,
      });
    }

    return new Dictionary<string, object?>
    {
      ["filePath"] = result.FilePath,
      ["totalLines"] = result.TotalLines,
      ["recordCount"] = result.Records.Count,
      ["controlPointCount"] = result.ControlPoints.Count,
      ["setupCount"] = result.Setups.Count,
      ["observationCount"] = observationCount,
      ["warnings"] = result.Warnings,
      ["controlPoints"] = controlPoints,
      ["setups"] = setups,
      ["records"] = records,
    };
  }

  private static Dictionary<string, object?> ProjectRecord(FbkRecord record) => new()
  {
    ["line"] = record.LineNumber,
    ["type"] = record.Type.ToString(),
    ["pt"] = record.PointNumber,
    ["n"] = record.N,
    ["e"] = record.E,
    ["z"] = record.Z,
    ["hi"] = record.InstrumentHeight,
    ["circle"] = record.Circle,
    ["azFrom"] = record.AzFrom,
    ["azTo"] = record.AzTo,
    ["azDms"] = record.AzimuthDms,
    ["azimuthDegrees"] = DmsPackedToDegrees(record.AzimuthDms),
    ["prismHeight"] = record.PrismHeight,
    ["angleFlavor"] = record.AngleFlavor,
    ["ha"] = record.Ha,
    ["sd"] = record.Sd,
    ["va"] = record.Va,
    ["haDegrees"] = DmsPackedToDegrees(record.Ha),
    ["vaDegrees"] = DmsPackedToDegrees(record.Va),
    ["desc"] = record.Description,
    ["warning"] = record.Warning,
  };

  private static FbkParseResult ParseFbkResult(string fbkPath)
  {
    var result = new FbkParseResult { FilePath = fbkPath };
    var lines = File.ReadAllLines(fbkPath);
    result.TotalLines = lines.Length;

    var currentPrism = 0.0;
    FbkSetupBlock? currentSetup = null;

    for (var index = 0; index < lines.Length; index++)
    {
      var record = ParseFbkLine(lines[index], index + 1);
      if (record == null) continue;
      result.Records.Add(record);

      if (!string.IsNullOrEmpty(record.Warning))
      {
        result.Warnings.Add($"Line {record.LineNumber}: {record.Warning}");
      }

      switch (record.Type)
      {
        case FbkRecordType.Nez:
          // Coordinate points, in file order. The donor records every NEZ here.
          result.ControlPoints.Add(record);
          break;

        case FbkRecordType.Stn:
          // A station reconfirmed before any shot replaces the dead setup instead of adding one.
          if (currentSetup != null && currentSetup.Observations.Count == 0)
          {
            currentSetup.StationPoint = record.PointNumber ?? 0;
            currentSetup.InstrumentHeight = record.InstrumentHeight ?? 0;
            currentSetup.Description = record.Description;
            currentSetup.BacksightPoint = null;
            currentSetup.BacksightCircleDms = null;
            currentSetup.AzimuthDms = null;
            currentSetup.AzFrom = null;
            currentSetup.AzTo = null;
          }
          else
          {
            currentSetup = new FbkSetupBlock
            {
              StationPoint = record.PointNumber ?? 0,
              InstrumentHeight = record.InstrumentHeight ?? 0,
              Description = record.Description,
            };
            result.Setups.Add(currentSetup);
          }
          break;

        case FbkRecordType.Bs:
          if (currentSetup == null)
          {
            result.Warnings.Add($"Line {record.LineNumber}: BS before STN, ignored");
            break;
          }
          currentSetup.BacksightPoint = record.PointNumber;
          currentSetup.BacksightCircleDms = record.Circle;
          break;

        case FbkRecordType.Az:
          if (currentSetup == null)
          {
            result.Warnings.Add($"Line {record.LineNumber}: AZ before STN, ignored");
            break;
          }
          currentSetup.AzimuthDms = record.AzimuthDms;
          currentSetup.AzFrom = record.AzFrom;
          currentSetup.AzTo = record.AzTo;
          break;

        case FbkRecordType.Prism:
          currentPrism = record.PrismHeight ?? 0.0;
          break;

        case FbkRecordType.F1:
        case FbkRecordType.F2:
          if (currentSetup == null)
          {
            result.Warnings.Add($"Line {record.LineNumber}: observation before STN, ignored");
            break;
          }
          // Stamp the target height in force onto the observation, so nothing has to re-walk the file.
          record.PrismHeight ??= currentPrism;
          currentSetup.Observations.Add(record);
          break;
      }
    }

    return result;
  }
}
