using System.Collections.Specialized;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

/// <summary>
/// Handlers for the civil3d_plot domain: layout/page-setup/plotter discovery
/// and PDF output of paper-space layouts.
///
/// Implementation choice (why commands, not PlotEngine):
///   Live testing against Civil 3D 2027 found that PlotFactory/PlotEngine is
///   crash-prone when driven from a command/SendCommand context -- which is
///   exactly the context this plugin runs host work in -- and a crash takes
///   the whole application (and any unsaved work) down. The -PLOT command
///   driven with BACKGROUNDPLOT=0 is slower but fails with a prompt or a
///   message instead of crashing. The same testing found that
///   PlotSettingsValidator.SetPlotCentered throws for Layout plots and that
///   changing layouts inside an open transaction crashes, so this module:
///     * only READS plot settings through .NET (short, disposed transactions,
///       plus throwaway non-database-resident PlotSettings for media lookups);
///     * never modifies a layout or page setup ("Save changes to page setup?
///       No");
///     * issues -PLOT / -PUBLISH through Editor.CommandAsync inside
///       ExecuteInCommandContextAsync with FILEDIA=0, CMDECHO=0 and
///       BACKGROUNDPLOT=0, restoring every system variable afterwards;
///     * validates every answer (layout, device, paper, plot style table,
///       output path) BEFORE starting the command, so a bad value cannot shift
///       the prompt chain;
///     * verifies the output file exists, is non-empty and was written by this
///       run before reporting success.
///
/// The -PLOT prompt chain was established empirically with LASTPROMPT
/// logging on Civil 3D 2027 (detailed configuration = Yes,
/// "Plot paper space first?" before "Hide paperspace objects?", and no
/// "write to file?" prompt for a PDF device).
/// </summary>
public static class PlotCommands
{
  public const string DefaultPdfDevice = "DWG To PDF.pc3";
  private const long PageCountReadLimitBytes = 256L * 1024 * 1024;
  private static readonly Regex PdfPageObject = new(@"/Type\s*/Page(?![A-Za-z])", RegexOptions.Compiled);

  // -------------------------------------------------------------------------
  // plotListLayouts
  // -------------------------------------------------------------------------

  public static Task<object?> ListLayoutsAsync(JsonObject? parameters)
  {
    var includeModel = PluginRuntime.GetOptionalBool(parameters, "includeModel") ?? false;
    return CivilExecution.ReadAsync<object?>((doc, _, database, transaction) =>
    {
      var currentLayout = Convert.ToString(App.GetSystemVariable("CTAB"));
      var layouts = ReadLayouts(database, transaction)
        .Where(layout => includeModel || !layout.ModelType)
        .Select(layout => ToLayoutSummary(layout, currentLayout))
        .ToList();

      return new Dictionary<string, object?>
      {
        ["drawing"] = doc.Name,
        ["currentLayout"] = currentLayout,
        ["count"] = layouts.Count,
        ["layouts"] = layouts,
      };
    });
  }

  // -------------------------------------------------------------------------
  // plotListPageSetups
  // -------------------------------------------------------------------------

  public static Task<object?> ListPageSetupsAsync()
  {
    return CivilExecution.ReadAsync<object?>((_, _, database, transaction) =>
    {
      var pageSetups = new List<Dictionary<string, object?>>();
      var dictionary = (DBDictionary)transaction.GetObject(database.PlotSettingsDictionaryId, OpenMode.ForRead);
      foreach (DBDictionaryEntry entry in dictionary)
      {
        if (transaction.GetObject(entry.Value, OpenMode.ForRead) is not PlotSettings settings) continue;
        var summary = ToPlotSettingsSummary(settings);
        summary["name"] = entry.Key;
        summary["modelType"] = settings.ModelType;
        pageSetups.Add(summary);
      }

      return new Dictionary<string, object?>
      {
        ["count"] = pageSetups.Count,
        ["pageSetups"] = pageSetups.OrderBy(item => Convert.ToString(item["name"]), StringComparer.OrdinalIgnoreCase).ToList(),
      };
    });
  }

  // -------------------------------------------------------------------------
  // plotListPlotters
  // -------------------------------------------------------------------------

  public static Task<object?> ListPlottersAsync(JsonObject? parameters)
  {
    var device = PluginRuntime.GetOptionalString(parameters, "device");
    return CivilExecution.ReadAsync<object?>((_, _, database, transaction) =>
    {
      var validator = PlotSettingsValidator.Current;
      using var probe = new PlotSettings(false);
      validator.RefreshLists(probe);

      var devices = ToList(validator.GetPlotDeviceList());
      var styleSheets = ToList(validator.GetPlotStyleSheetList());
      List<Dictionary<string, object?>>? media = null;
      string? resolvedDevice = null;

      if (!string.IsNullOrWhiteSpace(device))
      {
        resolvedDevice = RequireDevice(devices, device);
        media = ReadMedia(probe, resolvedDevice)
          .Select(item => new Dictionary<string, object?>
          {
            ["canonicalName"] = item.Canonical,
            ["localeName"] = item.Locale,
          })
          .ToList();
      }

      return new Dictionary<string, object?>
      {
        ["devices"] = devices,
        ["plotStyleTables"] = styleSheets,
        ["defaultPdfDevice"] = DefaultPdfDevice,
        ["pdfDeviceAvailable"] = devices.Any(name => string.Equals(name, DefaultPdfDevice, StringComparison.OrdinalIgnoreCase)),
        ["device"] = resolvedDevice,
        ["media"] = media,
      };
    });
  }

  // -------------------------------------------------------------------------
  // plotLayoutsToPdf
  // -------------------------------------------------------------------------

  public static Task<object?> PlotLayoutsToPdfAsync(JsonObject? parameters)
  {
    var requestedLayouts = GetOptionalStringArray(parameters, "layoutNames");
    var allLayouts = PluginRuntime.GetOptionalBool(parameters, "allLayouts") ?? false;
    var outputDirectory = PluginRuntime.GetOptionalString(parameters, "outputDirectory");
    var outputPath = PluginRuntime.GetOptionalString(parameters, "outputPath");
    var fileNamePrefix = PluginRuntime.GetOptionalString(parameters, "fileNamePrefix");
    var pageSetup = PluginRuntime.GetOptionalString(parameters, "pageSetup");
    var paperSize = PluginRuntime.GetOptionalString(parameters, "paperSize");
    var plotStyleTable = PluginRuntime.GetOptionalString(parameters, "plotStyleTable");
    var orientation = PluginRuntime.GetOptionalString(parameters, "orientation");
    var overwrite = PluginRuntime.GetOptionalBool(parameters, "overwrite") ?? false;
    var continueOnError = PluginRuntime.GetOptionalBool(parameters, "continueOnError") ?? true;

    if (allLayouts == (requestedLayouts.Count > 0))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Provide either a non-empty 'layoutNames' array or allLayouts=true (not both).");
    }
    if (string.IsNullOrWhiteSpace(outputDirectory) == string.IsNullOrWhiteSpace(outputPath))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Provide exactly one of 'outputDirectory' or 'outputPath'.");
    }
    if (orientation != null && orientation is not ("portrait" or "landscape"))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Parameter 'orientation' must be 'portrait' or 'landscape'.");
    }

    return CivilExecution.ExecuteCommandSequenceAsync<object?>(async (doc, cancellationToken) =>
    {
      // 1. Resolve and validate every job up front (read-only).
      var jobs = PreparePlotJobs(doc, requestedLayouts, allLayouts, pageSetup, paperSize, plotStyleTable, orientation);
      if (outputPath != null && jobs.Count != 1)
      {
        throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"'outputPath' plots exactly one layout, but {jobs.Count} layouts were selected. Use 'outputDirectory' instead.");
      }

      // 2. Resolve every output path through the filesystem boundary before
      //    anything is plotted, so a rejected path cannot leave partial output.
      var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var drawingBase = SanitizeFileName(Path.GetFileNameWithoutExtension(doc.Name));
      foreach (var job in jobs)
      {
        var raw = outputPath ?? Path.Combine(
          outputDirectory!,
          UniqueFileName(usedNames, $"{fileNamePrefix ?? drawingBase + "-"}{SanitizeFileName(job.LayoutName)}") + ".pdf");
        job.OutputPath = FileBoundary.ResolveExportPath(raw, overwrite, ".pdf");
      }
      var duplicate = jobs.GroupBy(job => job.OutputPath, StringComparer.OrdinalIgnoreCase).FirstOrDefault(group => group.Count() > 1);
      if (duplicate != null)
      {
        throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Two layouts resolve to the same output file: {duplicate.Key}");
      }

      // 3. Plot, one -PLOT per layout, with sysvars saved and restored.
      var results = new List<Dictionary<string, object?>>();
      var warnings = new List<string>();
      var stopReason = (string?)null;
      var overall = Stopwatch.StartNew();

      using (var sysvars = new SystemVariableScope())
      {
        sysvars.Set("FILEDIA", 0);
        sysvars.Set("CMDECHO", 0);
        sysvars.Set("BACKGROUNDPLOT", 0);
        sysvars.Remember("CTAB");

        foreach (var job in jobs)
        {
          if (stopReason != null)
          {
            results.Add(LayoutResult(job, "skipped", null, stopReason, 0));
            continue;
          }
          if (cancellationToken.IsCancellationRequested)
          {
            stopReason = "Cancellation was requested; remaining layouts were not plotted.";
            results.Add(LayoutResult(job, "skipped", null, stopReason, 0));
            continue;
          }

          var watch = Stopwatch.StartNew();
          try
          {
            var file = await PlotOneAsync(doc, job, overwrite);
            results.Add(LayoutResult(job, "plotted", file, null, watch.ElapsedMilliseconds));
          }
          catch (Exception ex)
          {
            var message = ex is JsonRpcDispatchException ? ex.Message : $"{ex.GetType().Name}: {ex.Message}";
            results.Add(LayoutResult(job, "failed", null, message, watch.ElapsedMilliseconds));
            if (ex is JsonRpcDispatchException { Code: CommandIncompleteCode })
            {
              stopReason = "An earlier -PLOT did not complete; remaining layouts were not plotted.";
            }
            else if (!continueOnError)
            {
              stopReason = "Stopped after the first failure (continueOnError=false).";
            }
          }
        }

        warnings.AddRange(sysvars.RestoreWarnings());
      }

      var plotted = results.Count(item => Equals(item["status"], "plotted"));
      if (plotted == 0)
      {
        var firstError = results.Select(item => item["error"] as string).FirstOrDefault(error => error != null);
        throw new JsonRpcDispatchException("CIVIL3D.API_ERROR", $"No layouts were plotted. {firstError}".Trim());
      }
      if (plotted < results.Count)
      {
        warnings.Add($"{results.Count - plotted} of {results.Count} layouts were not plotted; see per-layout status.");
      }

      return new Dictionary<string, object?>
      {
        ["device"] = DefaultPdfDevice,
        ["method"] = "-PLOT (BACKGROUNDPLOT=0)",
        ["requested"] = results.Count,
        ["plotted"] = plotted,
        ["failed"] = results.Count(item => Equals(item["status"], "failed")),
        ["skipped"] = results.Count(item => Equals(item["status"], "skipped")),
        ["totalBytes"] = results.Sum(item => item["bytes"] is long bytes ? bytes : 0L),
        ["durationMs"] = overall.ElapsedMilliseconds,
        ["layouts"] = results,
        ["warnings"] = warnings,
      };
    });
  }

  // -------------------------------------------------------------------------
  // plotPublishSheetSet
  // -------------------------------------------------------------------------

  public static Task<object?> PublishSheetSetAsync(JsonObject? parameters)
  {
    var outputPathRaw = PluginRuntime.GetRequiredString(parameters, "outputPath");
    var overwrite = PluginRuntime.GetOptionalBool(parameters, "overwrite") ?? false;
    var requireSaved = PluginRuntime.GetOptionalBool(parameters, "requireSaved") ?? true;
    var keepDsd = PluginRuntime.GetOptionalBool(parameters, "keepDsd") ?? false;
    var layoutNames = GetOptionalStringArray(parameters, "layoutNames");
    var sheetsNode = parameters?["sheets"] as JsonArray;

    if (layoutNames.Count > 0 && sheetsNode is { Count: > 0 })
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Provide 'layoutNames' or 'sheets', not both.");
    }

    var requestedSheets = new List<(string Layout, string? DrawingPath)>();
    foreach (var name in layoutNames) requestedSheets.Add((name, null));
    if (sheetsNode != null)
    {
      foreach (var node in sheetsNode)
      {
        if (node is not JsonObject sheet)
        {
          throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Each entry in 'sheets' must be an object with 'layoutName' and optional 'drawingPath'.");
        }
        requestedSheets.Add((
          PluginRuntime.GetRequiredString(sheet, "layoutName"),
          PluginRuntime.GetOptionalString(sheet, "drawingPath")));
      }
    }

    return CivilExecution.ExecuteCommandSequenceAsync<object?>(async (doc, cancellationToken) =>
    {
      var warnings = new List<string>();
      var currentPath = doc.Database.Filename;
      var titled = Convert.ToInt32(App.GetSystemVariable("DWGTITLED") ?? 0) != 0;
      var unsaved = Convert.ToInt32(App.GetSystemVariable("DBMOD") ?? 0) != 0;

      // Resolve sheets. Current-drawing layouts are validated against the
      // layout dictionary; external drawings go through the import boundary.
      var currentLayouts = ReadLayoutSnapshots(doc).Where(layout => !layout.ModelType).ToList();
      var sheets = new List<PublishSheet>();
      if (requestedSheets.Count == 0)
      {
        // PUBLISH refuses layouts that were never initialized (never opened,
        // so no paper-space viewport or page size yet); skip and report them
        // instead of failing the whole set.
        sheets.AddRange(currentLayouts.Where(layout => layout.Initialized).OrderBy(layout => layout.TabOrder).Select(layout => new PublishSheet(layout.Name, null)));
        var uninitialized = currentLayouts.Where(layout => !layout.Initialized).OrderBy(layout => layout.TabOrder).Select(layout => layout.Name).ToList();
        if (uninitialized.Count > 0)
        {
          warnings.Add($"Skipped {uninitialized.Count} layout(s) that were never initialized: {Preview(uninitialized)}. Open each layout tab once and save the drawing to include it.");
        }
        if (sheets.Count == 0)
        {
          throw uninitialized.Count > 0
            ? new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"None of the drawing's paper-space layouts have been initialized ({Preview(uninitialized)}). Open each layout tab once and save the drawing before publishing.")
            : new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", "The active drawing has no paper-space layouts to publish.");
        }
      }
      else
      {
        foreach (var (layout, drawingPath) in requestedSheets)
        {
          if (string.IsNullOrWhiteSpace(drawingPath))
          {
            var match = currentLayouts.FirstOrDefault(item => string.Equals(item.Name, layout, StringComparison.OrdinalIgnoreCase))
              ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", LayoutNotFoundMessage(layout, currentLayouts));
            RequireInitialized(match);
            sheets.Add(new PublishSheet(match.Name, null));
          }
          else
          {
            var resolved = FileBoundary.ResolveImportPath(drawingPath, ".dwg");
            if (string.Equals(resolved, currentPath, StringComparison.OrdinalIgnoreCase))
            {
              var match = currentLayouts.FirstOrDefault(item => string.Equals(item.Name, layout, StringComparison.OrdinalIgnoreCase))
                ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", LayoutNotFoundMessage(layout, currentLayouts));
              RequireInitialized(match);
              sheets.Add(new PublishSheet(match.Name, null));
            }
            else
            {
              sheets.Add(new PublishSheet(layout, resolved));
              warnings.Add($"Layout '{layout}' in external drawing '{resolved}' was not pre-validated; PUBLISH reports missing layouts itself.");
            }
          }
        }
      }

      if (sheets.Any(sheet => sheet.DrawingPath == null))
      {
        // PUBLISH reads the drawing from disk, so an untitled drawing cannot be
        // published and unsaved edits may be missing from the PDF.
        if (!titled || string.IsNullOrWhiteSpace(currentPath) || !File.Exists(currentPath))
        {
          throw new JsonRpcDispatchException("CIVIL3D.CONFLICT", "The active drawing has never been saved. Save it (civil3d_drawing action=save) before publishing its layouts.");
        }
        if (unsaved)
        {
          if (requireSaved)
          {
            throw new JsonRpcDispatchException("CIVIL3D.CONFLICT", "The active drawing has unsaved changes that PUBLISH may not include. Save it first, or pass requireSaved=false to publish the last saved state.");
          }
          warnings.Add("The active drawing has unsaved changes; the PDF may reflect the last saved state.");
        }
      }

      var outputPath = FileBoundary.ResolveExportPath(outputPathRaw, overwrite, ".pdf");
      var dsdPath = FileBoundary.ResolveExportPath(Path.ChangeExtension(outputPath, ".mcp-publish.dsd"), true, ".dsd");

      var watch = Stopwatch.StartNew();
      var startedUtc = DateTime.UtcNow;
      OutputFile file;
      // PUBLISH writes to a hidden, unpredictable name in the locked output
      // directory (the DSD's DWF= target); the finished PDF is then renamed
      // over the final name, and a failed publish never deletes an existing PDF.
      using (var output = FileBoundary.BeginExternalWrite(outputPath, overwrite))
      {
        try
        {
          FileBoundary.WriteAllTextAtomic(dsdPath, BuildDsd(sheets, currentPath, output.TempPath), new UTF8Encoding(false), true, ".dsd");

          using var sysvars = new SystemVariableScope();
          sysvars.Set("FILEDIA", 0);
          sysvars.Set("CMDECHO", 0);
          sysvars.Set("BACKGROUNDPLOT", 0);
          sysvars.Set("PUBLISHCOLLATE", 1);

          cancellationToken.ThrowIfCancellationRequested();
          await CommandLineRunner.RunAsync(doc, "PUBLISH", "_.-PUBLISH", dsdPath);
          warnings.AddRange(sysvars.RestoreWarnings());
        }
        finally
        {
          if (!keepDsd)
          {
            TryDelete(dsdPath);
          }
        }

        file = VerifyOutput(output.TempPath, startedUtc);
        output.Commit();
        file = file with { Path = output.FinalPath };
      }
      if (file.PageCount is int pages && pages != sheets.Count)
      {
        warnings.Add($"Expected {sheets.Count} pages but the PDF appears to contain {pages}; check the sheet list.");
      }

      return new Dictionary<string, object?>
      {
        ["outputPath"] = file.Path,
        ["bytes"] = file.Bytes,
        ["pageCount"] = file.PageCount,
        ["sheetCount"] = sheets.Count,
        ["sheets"] = sheets.Select((sheet, index) => new Dictionary<string, object?>
        {
          ["index"] = index + 1,
          ["layoutName"] = sheet.LayoutName,
          ["drawingPath"] = sheet.DrawingPath ?? currentPath,
        }).ToList(),
        ["method"] = "-PUBLISH with generated DSD (BACKGROUNDPLOT=0, multi-sheet PDF)",
        ["dsdPath"] = keepDsd ? dsdPath : null,
        ["durationMs"] = watch.ElapsedMilliseconds,
        ["published"] = true,
        ["warnings"] = warnings,
      };
    });
  }

  // =========================================================================
  // Plot preparation (read-only)
  // =========================================================================

  private sealed class PlotJob
  {
    public required string LayoutName { get; init; }
    public required string PaperSize { get; init; }
    public required string PaperUnitsToken { get; init; }
    public required string OrientationToken { get; init; }
    public required bool UpsideDown { get; init; }
    public required string StyleSheetToken { get; init; }
    public string? PageSetup { get; init; }
    public string? OutputPath { get; set; }
    public DateTime StartedUtc { get; set; }
  }

  private sealed record PublishSheet(string LayoutName, string? DrawingPath);

  private sealed record LayoutSnapshot(string Name, int TabOrder, bool ModelType, bool Initialized = true);

  private static void RequireInitialized(LayoutSnapshot layout)
  {
    if (!layout.Initialized)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"Layout '{layout.Name}' has never been initialized, and PUBLISH refuses uninitialized layouts. Open the layout tab once and save the drawing, then publish again.");
    }
  }

  // A paper-space layout gets its overall paper-space viewport (and a page
  // size) when it is first opened; until then it has no viewports.
  private static bool IsInitialized(Layout layout)
  {
    if (layout.ModelType)
    {
      return true;
    }

    try
    {
      return layout.GetViewports().Count > 0;
    }
    catch
    {
      // Unknown: let PUBLISH report it rather than block a valid sheet.
      return true;
    }
  }

  private sealed record MediaName(string Canonical, string Locale);

  private sealed record OutputFile(string Path, long Bytes, int? PageCount, DateTime LastWriteUtc);

  private static List<PlotJob> PreparePlotJobs(
    Document doc,
    IReadOnlyList<string> requestedLayouts,
    bool allLayouts,
    string? pageSetup,
    string? paperSize,
    string? plotStyleTable,
    string? orientation)
  {
    var database = doc.Database;
    using var documentLock = doc.LockDocument();
    using var transaction = database.TransactionManager.StartTransaction();

    var layouts = ReadLayouts(database, transaction).ToList();
    var paperLayouts = layouts.Where(layout => !layout.ModelType).OrderBy(layout => layout.TabOrder).ToList();

    List<Layout> selected;
    if (allLayouts)
    {
      selected = paperLayouts;
      if (selected.Count == 0)
      {
        throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", "The active drawing has no paper-space layouts to plot.");
      }
    }
    else
    {
      selected = [];
      foreach (var name in requestedLayouts)
      {
        var layout = layouts.FirstOrDefault(item => string.Equals(item.LayoutName, name, StringComparison.OrdinalIgnoreCase))
          ?? throw new JsonRpcDispatchException(
            "CIVIL3D.OBJECT_NOT_FOUND",
            LayoutNotFoundMessage(name, paperLayouts.Select(item => new LayoutSnapshot(item.LayoutName, item.TabOrder, false))));
        if (layout.ModelType)
        {
          throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "The Model layout cannot be plotted by this tool; plot a paper-space layout (its -PLOT prompt chain differs).");
        }
        if (!selected.Contains(layout)) selected.Add(layout);
      }
    }

    PlotSettings? namedSetup = null;
    if (!string.IsNullOrWhiteSpace(pageSetup))
    {
      var dictionary = (DBDictionary)transaction.GetObject(database.PlotSettingsDictionaryId, OpenMode.ForRead);
      foreach (DBDictionaryEntry entry in dictionary)
      {
        if (!string.Equals(entry.Key, pageSetup, StringComparison.OrdinalIgnoreCase)) continue;
        namedSetup = transaction.GetObject(entry.Value, OpenMode.ForRead) as PlotSettings;
        break;
      }
      if (namedSetup == null)
      {
        throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Page setup '{pageSetup}' was not found. Use civil3d_plot action=list_page_setups.");
      }
      if (namedSetup.ModelType)
      {
        throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Page setup '{pageSetup}' is a model-space page setup and cannot be applied to a paper-space layout.");
      }
    }

    var validator = PlotSettingsValidator.Current;
    using var probe = new PlotSettings(false);
    validator.RefreshLists(probe);
    var devices = ToList(validator.GetPlotDeviceList());
    RequireDevice(devices, DefaultPdfDevice);
    var styleSheets = ToList(validator.GetPlotStyleSheetList());
    if (!string.IsNullOrWhiteSpace(plotStyleTable) &&
        !styleSheets.Any(name => string.Equals(name, plotStyleTable, StringComparison.OrdinalIgnoreCase)))
    {
      throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Plot style table '{plotStyleTable}' was not found. Available: {Preview(styleSheets)}.");
    }

    var pdfMedia = ReadMedia(probe, DefaultPdfDevice);
    var jobs = new List<PlotJob>();
    foreach (var layout in selected)
    {
      PlotSettings source = namedSetup ?? layout;
      var paper = ResolvePaper(pdfMedia, paperSize, source.CanonicalMediaName, layout.LayoutName);
      var rotation = source.PlotRotation;
      var landscape = rotation is PlotRotation.Degrees090 or PlotRotation.Degrees270;
      if (orientation != null) landscape = orientation == "landscape";
      var styleSheet = plotStyleTable ?? source.CurrentStyleSheet;

      jobs.Add(new PlotJob
      {
        LayoutName = layout.LayoutName,
        PageSetup = namedSetup != null ? pageSetup : NullIfEmpty(layout.PlotSettingsName),
        PaperSize = paper,
        PaperUnitsToken = source.PlotPaperUnits == PlotPaperUnit.Millimeters ? "_M" : "_I",
        OrientationToken = landscape ? "_L" : "_P",
        UpsideDown = rotation is PlotRotation.Degrees180 or PlotRotation.Degrees270,
        // "." answers "Enter plot style table name ... (enter . for none)".
        StyleSheetToken = string.IsNullOrWhiteSpace(styleSheet) ? "." : styleSheet,
      });
    }

    transaction.Commit();
    return jobs;
  }

  private static string ResolvePaper(IReadOnlyList<MediaName> pdfMedia, string? requested, string? sourceCanonical, string layoutName)
  {
    if (!string.IsNullOrWhiteSpace(requested))
    {
      var match = pdfMedia.FirstOrDefault(item =>
        string.Equals(item.Locale, requested, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(item.Canonical, requested, StringComparison.OrdinalIgnoreCase));
      return match?.Locale ?? throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"Paper size '{requested}' is not available on {DefaultPdfDevice}. Use civil3d_plot action=list_plotters with device='{DefaultPdfDevice}' to list media. Examples: {Preview(pdfMedia.Select(item => item.Locale))}.");
    }

    var fromLayout = pdfMedia.FirstOrDefault(item => string.Equals(item.Canonical, sourceCanonical, StringComparison.OrdinalIgnoreCase));
    return fromLayout?.Locale ?? throw new JsonRpcDispatchException(
      "CIVIL3D.INVALID_INPUT",
      $"Layout '{layoutName}' uses paper '{sourceCanonical}', which {DefaultPdfDevice} does not provide. Pass 'paperSize' (for example '{pdfMedia.FirstOrDefault()?.Locale}') or a PDF page setup.");
  }

  // =========================================================================
  // Command execution
  // =========================================================================

  // A command left waiting for input is reported with this code so a batch
  // stops instead of feeding the next layout's answers into a stale prompt.
  private const string CommandIncompleteCode = CommandLineRunner.IncompleteCode;

  private static async Task<OutputFile> PlotOneAsync(Document doc, PlotJob job, bool overwrite)
  {
    // The plotter writes to a hidden, unpredictable name in the locked output
    // directory; the finished file is then renamed over the final name. This
    // also means a failed plot never deletes an existing PDF.
    using var output = FileBoundary.BeginExternalWrite(job.OutputPath!, overwrite);

    // Make the layout current first so the layout-name prompt default is the
    // target, then answer the verified chain.
    App.SetSystemVariable("CTAB", job.LayoutName);
    job.StartedUtc = DateTime.UtcNow;

    await CommandLineRunner.RunAsync(
      doc,
      "PLOT",
      "_.-PLOT",
      "_Y",                         // Detailed plot configuration?
      job.LayoutName,               // Layout name
      DefaultPdfDevice,             // Output device
      job.PaperSize,                // Paper size (locale name for the device)
      job.PaperUnitsToken,          // Paper units
      job.OrientationToken,         // Drawing orientation
      job.UpsideDown ? "_Y" : "_N", // Plot upside down?
      "_L",                         // Plot area = Layout
      "1:1",                        // Plot scale (viewports carry the drawing scale)
      "0.00,0.00",                  // Plot offset
      "_Y",                         // Plot with plot styles?
      job.StyleSheetToken,          // Plot style table name ("." = none)
      "_Y",                         // Plot with lineweights?
      "_N",                         // Scale lineweights with plot scale?
      "_N",                         // Plot paper space first?
      "_N",                         // Hide paperspace objects?
      output.TempPath,              // File name (PDF devices ask directly)
      "_N",                         // Save changes to page setup?
      "_Y");                        // Proceed with plot?

    var file = VerifyOutput(output.TempPath, job.StartedUtc);
    output.Commit();
    return file with { Path = output.FinalPath };
  }

  private static OutputFile VerifyOutput(string path, DateTime startedUtc)
  {
    var info = new FileInfo(path);
    if (!info.Exists)
    {
      throw new JsonRpcDispatchException("CIVIL3D.API_ERROR", $"The plot command finished but no PDF was written to '{path}'.");
    }
    info.Refresh();
    // Allow for coarse filesystem timestamps.
    if (info.LastWriteTimeUtc < startedUtc.AddSeconds(-2))
    {
      throw new JsonRpcDispatchException("CIVIL3D.API_ERROR", $"'{path}' exists but was not written by this plot run.");
    }
    if (info.Length == 0)
    {
      throw new JsonRpcDispatchException("CIVIL3D.API_ERROR", $"'{path}' was written but is empty.");
    }

    return new OutputFile(info.FullName, info.Length, CountPdfPages(info), info.LastWriteTimeUtc);
  }

  // Heuristic: counts uncompressed /Type /Page objects. Returns null when the
  // file is too large to scan or uses compressed object streams (count 0).
  private static int? CountPdfPages(FileInfo info)
  {
    try
    {
      if (info.Length > PageCountReadLimitBytes) return null;
      var text = Encoding.Latin1.GetString(File.ReadAllBytes(info.FullName));
      var count = PdfPageObject.Matches(text).Count;
      return count > 0 ? count : null;
    }
    catch
    {
      return null;
    }
  }

  private static string BuildDsd(IReadOnlyList<PublishSheet> sheets, string currentPath, string outputPath)
  {
    // DSD (Drawing Set Description) is the INI-style sheet list PUBLISH reads.
    // Target Type=6 selects a multi-sheet PDF written to DWF= (the key name is
    // historical); PromptForDwfName=FALSE keeps -PUBLISH non-interactive.
    var builder = new StringBuilder();
    builder.AppendLine("[DWF6Version]");
    builder.AppendLine("Ver=1");
    builder.AppendLine("[DWF6MinorVersion]");
    builder.AppendLine("MinorVer=1");
    var sectionNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var sheet in sheets)
    {
      var dwg = sheet.DrawingPath ?? currentPath;
      var section = UniqueFileName(sectionNames, $"{Path.GetFileNameWithoutExtension(dwg)}-{sheet.LayoutName}");
      builder.AppendLine($"[DWF6Sheet:{section}]");
      builder.AppendLine($"DWG={dwg}");
      builder.AppendLine($"Layout={sheet.LayoutName}");
      builder.AppendLine("Setup=");
      builder.AppendLine($"OriginalSheetPath={dwg}");
      builder.AppendLine("Has Plot Port=0");
      builder.AppendLine("Has3DDWF=0");
    }
    builder.AppendLine("[Target]");
    builder.AppendLine("Type=6");
    builder.AppendLine($"DWF={outputPath}");
    builder.AppendLine($"OUT={Path.GetDirectoryName(outputPath)}{Path.DirectorySeparatorChar}");
    builder.AppendLine("PWD=");
    builder.AppendLine("[PdfOptions]");
    builder.AppendLine("IncludeHyperlinks=TRUE");
    builder.AppendLine("CreateBookmarks=TRUE");
    builder.AppendLine("CaptureFontsInDrawing=TRUE");
    builder.AppendLine("ConvertTextToGeometry=FALSE");
    builder.AppendLine("VectorResolution=1200");
    builder.AppendLine("RasterResolution=400");
    builder.AppendLine("[AutoCAD Block Data]");
    builder.AppendLine("IncludeBlockInfo=0");
    builder.AppendLine("BlockTmplFilePath=");
    builder.AppendLine("[SheetSet Properties]");
    builder.AppendLine("IsSheetSet=FALSE");
    builder.AppendLine("IsHomogeneous=FALSE");
    builder.AppendLine("SheetSet Name=");
    builder.AppendLine("NoOfCopies=1");
    builder.AppendLine("PlotStampOn=FALSE");
    builder.AppendLine("ViewFile=FALSE");
    builder.AppendLine("JobID=0");
    builder.AppendLine("SelectionSetName=");
    builder.AppendLine("AcadProfile=");
    builder.AppendLine("CategoryName=");
    builder.AppendLine("LogFilePath=");
    builder.AppendLine("IncludeLayer=FALSE");
    builder.AppendLine("LineMerge=FALSE");
    builder.AppendLine("CurrentPrecision=");
    builder.AppendLine("PromptForDwfName=FALSE");
    builder.AppendLine("PwdProtectPublishedDWF=FALSE");
    builder.AppendLine("PromptForPwd=FALSE");
    builder.AppendLine("RepublishingMarkups=FALSE");
    builder.AppendLine("DSDType=1");
    builder.AppendLine("PublishSheetSetMetadata=FALSE");
    builder.AppendLine("PublishSubsets=FALSE");
    return builder.ToString();
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /// <summary>Sets system variables and restores the originals on dispose.</summary>
  private sealed class SystemVariableScope : IDisposable
  {
    private readonly List<(string Name, object? Value)> originals = [];
    private readonly List<string> warnings = [];
    private bool restored;

    public void Remember(string name)
    {
      if (originals.Any(item => item.Name == name)) return;
      originals.Add((name, App.GetSystemVariable(name)));
    }

    public void Set(string name, object value)
    {
      Remember(name);
      App.SetSystemVariable(name, value);
    }

    public IEnumerable<string> RestoreWarnings()
    {
      Restore();
      return warnings;
    }

    public void Dispose() => Restore();

    private void Restore()
    {
      if (restored) return;
      restored = true;
      for (var index = originals.Count - 1; index >= 0; index--)
      {
        var (name, value) = originals[index];
        try
        {
          if (value != null) App.SetSystemVariable(name, value);
        }
        catch (Exception ex)
        {
          warnings.Add($"Could not restore system variable {name}: {ex.Message}");
        }
      }
    }
  }

  private static IEnumerable<Layout> ReadLayouts(Database database, Transaction transaction)
  {
    var dictionary = (DBDictionary)transaction.GetObject(database.LayoutDictionaryId, OpenMode.ForRead);
    foreach (DBDictionaryEntry entry in dictionary)
    {
      if (transaction.GetObject(entry.Value, OpenMode.ForRead) is Layout layout)
      {
        yield return layout;
      }
    }
  }

  private static List<LayoutSnapshot> ReadLayoutSnapshots(Document doc)
  {
    using var documentLock = doc.LockDocument();
    using var transaction = doc.Database.TransactionManager.StartTransaction();
    var snapshots = ReadLayouts(doc.Database, transaction)
      .Select(layout => new LayoutSnapshot(layout.LayoutName, layout.TabOrder, layout.ModelType, IsInitialized(layout)))
      .ToList();
    transaction.Commit();
    return snapshots;
  }

  private static Dictionary<string, object?> ToLayoutSummary(Layout layout, string? currentLayout)
  {
    var summary = ToPlotSettingsSummary(layout);
    summary["name"] = layout.LayoutName;
    summary["tabOrder"] = layout.TabOrder;
    summary["isModel"] = layout.ModelType;
    summary["isCurrent"] = string.Equals(layout.LayoutName, currentLayout, StringComparison.OrdinalIgnoreCase);
    summary["pageSetup"] = NullIfEmpty(layout.PlotSettingsName);
    summary["handle"] = layout.Handle.ToString();
    return summary;
  }

  private static Dictionary<string, object?> ToPlotSettingsSummary(PlotSettings settings)
  {
    var rotation = settings.PlotRotation;
    return new Dictionary<string, object?>
    {
      ["device"] = NullIfEmpty(settings.PlotConfigurationName),
      ["canonicalMediaName"] = NullIfEmpty(settings.CanonicalMediaName),
      ["paperUnits"] = settings.PlotPaperUnits.ToString(),
      ["paperWidth"] = settings.PlotPaperSize.X,
      ["paperHeight"] = settings.PlotPaperSize.Y,
      ["orientation"] = rotation is PlotRotation.Degrees090 or PlotRotation.Degrees270 ? "landscape" : "portrait",
      ["rotation"] = rotation.ToString(),
      ["plotType"] = settings.PlotType.ToString(),
      ["plotStyleTable"] = NullIfEmpty(settings.CurrentStyleSheet),
    };
  }

  private static List<MediaName> ReadMedia(PlotSettings probe, string device)
  {
    var validator = PlotSettingsValidator.Current;
    validator.SetPlotConfigurationName(probe, device, null);
    validator.RefreshLists(probe);
    var media = new List<MediaName>();
    foreach (var canonical in ToList(validator.GetCanonicalMediaNameList(probe)))
    {
      string locale;
      try
      {
        locale = validator.GetLocaleMediaName(probe, canonical);
      }
      catch
      {
        locale = canonical;
      }
      media.Add(new MediaName(canonical, string.IsNullOrWhiteSpace(locale) ? canonical : locale));
    }
    return media;
  }

  private static string RequireDevice(IReadOnlyList<string> devices, string device)
  {
    return devices.FirstOrDefault(name => string.Equals(name, device, StringComparison.OrdinalIgnoreCase))
      ?? throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Plot device '{device}' is not configured. Available: {Preview(devices)}.");
  }

  private static List<string> ToList(StringCollection? collection)
  {
    var list = new List<string>();
    if (collection == null) return list;
    foreach (var item in collection)
    {
      if (!string.IsNullOrWhiteSpace(item)) list.Add(item);
    }
    return list;
  }

  private static List<string> GetOptionalStringArray(JsonObject? parameters, string name)
  {
    if (PluginRuntime.GetParameter(parameters, name) is not JsonArray array) return [];
    var values = new List<string>();
    foreach (var node in array)
    {
      var value = node?.GetValue<string>();
      if (string.IsNullOrWhiteSpace(value))
      {
        throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Parameter '{name}' must contain only non-empty strings.");
      }
      values.Add(value);
    }
    return values;
  }

  private static Dictionary<string, object?> LayoutResult(PlotJob job, string status, OutputFile? file, string? error, long durationMs)
  {
    return new Dictionary<string, object?>
    {
      ["layoutName"] = job.LayoutName,
      ["status"] = status,
      ["outputPath"] = file?.Path ?? job.OutputPath,
      ["bytes"] = file?.Bytes,
      ["pageCount"] = file?.PageCount,
      ["paperSize"] = job.PaperSize,
      ["orientation"] = job.OrientationToken == "_L" ? "landscape" : "portrait",
      ["plotStyleTable"] = job.StyleSheetToken == "." ? null : job.StyleSheetToken,
      ["pageSetup"] = job.PageSetup,
      ["durationMs"] = durationMs,
      ["error"] = error,
    };
  }

  private static string LayoutNotFoundMessage(string name, IEnumerable<LayoutSnapshot> available) =>
    $"Layout '{name}' was not found. Available paper-space layouts: {Preview(available.OrderBy(item => item.TabOrder).Select(item => item.Name))}.";

  private static void TryDelete(string path)
  {
    try
    {
      if (File.Exists(path)) File.Delete(path);
    }
    catch
    {
      // Leftover DSD files are harmless and uniquely named per output.
    }
  }

  private static string SanitizeFileName(string value)
  {
    var invalid = Path.GetInvalidFileNameChars();
    var cleaned = new string(value.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray()).Trim().TrimEnd('.');
    return string.IsNullOrWhiteSpace(cleaned) ? "layout" : cleaned;
  }

  private static string UniqueFileName(HashSet<string> used, string baseName)
  {
    var candidate = baseName;
    for (var suffix = 2; !used.Add(candidate); suffix++)
    {
      candidate = $"{baseName}_{suffix}";
    }
    return candidate;
  }

  private static string Preview(IEnumerable<string> values)
  {
    var list = values.ToList();
    if (list.Count == 0) return "(none)";
    var head = string.Join(", ", list.Take(12));
    return list.Count > 12 ? $"{head}, ... ({list.Count} total)" : head;
  }

  private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
