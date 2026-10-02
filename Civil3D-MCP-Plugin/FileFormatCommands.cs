using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Civil3DMcpPlugin;

/// <summary>
/// Word, Excel, PowerPoint and zip reading for the active session.
///
/// .docx / .xlsx / .pptx / .zip are all zip containers holding XML or plain
/// text, so System.IO.Compression plus a small XML scan is enough; no Office
/// COM, no NuGet package, no third-party reader. The legacy binaries
/// (.doc / .xls) live in <see cref="LegacyOfficeReaders"/>.
///
/// Every caller path passes FileBoundary.ResolveImportPath (canonicalized,
/// inside CIVIL3D_IMPORT_ROOTS, per-action extension allow-list, must exist,
/// no reparse-point traversal). Nothing here writes a file, and nothing is
/// ever extracted to disk: entries are read in memory and every read is
/// bounded by <see cref="MaxDecompressedEntryBytes"/>,
/// <see cref="MaxDecompressedTotalBytes"/> and <see cref="MaxZipEntries"/> so
/// a hostile archive cannot exhaust memory (zip-slip needs no defence because
/// no path is ever built from an entry name).
///
/// The readers run inside the host execution gate like every other plugin
/// method, but they take no transaction and touch no database object.
/// </summary>
public static class FileFormatCommands
{
  private const int DefaultMaxChars = 8000;
  private const int DefaultMaxRows = 50;
  private const int MaxTextChars = 200000;
  private const int MaxRows = 10000;

  /// <summary>Largest file this plugin will open as a whole (also bounds .doc/.xls).</summary>
  private const long MaxFileBytes = 64L * 1024 * 1024;

  /// <summary>Cap on one decompressed zip/OOXML entry. A single XML part above this is not readable text for a model.</summary>
  private const long MaxDecompressedEntryBytes = 32L * 1024 * 1024;

  /// <summary>Cap on the sum of decompressed bytes read from one archive, across all parts.</summary>
  private const long MaxDecompressedTotalBytes = 64L * 1024 * 1024;

  /// <summary>Cap on the number of entries one archive may list or walk.</summary>
  private const int MaxZipEntries = 2000;

  /// <summary>Largest zip entry the plugin will hand back as text (character budget is separate).</summary>
  private const long MaxZipTextEntryBytes = 1L * 1024 * 1024;

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------

  public static Task<object?> ReadDocxAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var maxChars = Clamp(PluginRuntime.GetOptionalInt(parameters, "maxChars") ?? DefaultMaxChars, 1, MaxTextChars);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var path = FileBoundary.ResolveImportPath(rawPath, ".docx");
      var text = ExtractDocxText(path);
      return BuildTextResult(path, "docx", text, maxChars);
    });
  }

  public static Task<object?> ReadDocAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var maxChars = Clamp(PluginRuntime.GetOptionalInt(parameters, "maxChars") ?? DefaultMaxChars, 1, MaxTextChars);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var path = FileBoundary.ResolveImportPath(rawPath, ".doc");
      var bytes = ReadAllBytes(path);
      string text;
      try
      {
        text = LegacyOfficeReaders.ReadDocText(bytes);
      }
      catch (InvalidDataException exception)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
          $"Not a readable Word 97-2003 (.doc) file: {path} ({exception.Message})");
      }

      return BuildTextResult(path, "doc", text, maxChars, "Word 97-2003 binary; text extracted from the piece table.");
    });
  }

  public static Task<object?> ReadXlsxAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var maxRows = Clamp(PluginRuntime.GetOptionalInt(parameters, "maxRows") ?? DefaultMaxRows, 1, MaxRows);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var path = FileBoundary.ResolveImportPath(rawPath, ".xlsx");
      var budget = new ZipReadBudget();
      using var archive = OpenZip(path);
      var shared = ReadArchiveText(archive, "xl/sharedStrings.xml", budget);
      var sharedStrings = shared == null ? new List<string>() : ParseSharedStrings(shared);
      var sheet = ReadArchiveText(archive, "xl/worksheets/sheet1.xml", budget)
        ?? throw new JsonRpcDispatchException(
          "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
          $"Not a valid .xlsx file (xl/worksheets/sheet1.xml is missing): {path}");

      var text = ParseSheet(sheet, sharedStrings, maxRows);
      return BuildTextResult(
        path,
        "xlsx",
        text,
        MaxTextChars,
        $"First worksheet, tab-separated, first {maxRows} rows; {sharedStrings.Count} shared strings.");
    });
  }

  public static Task<object?> ReadXlsAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var maxRows = Clamp(PluginRuntime.GetOptionalInt(parameters, "maxRows") ?? DefaultMaxRows, 1, MaxRows);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var path = FileBoundary.ResolveImportPath(rawPath, ".xls");
      var bytes = ReadAllBytes(path);
      string text;
      try
      {
        text = LegacyOfficeReaders.ReadXlsText(bytes, maxRows);
      }
      catch (InvalidDataException exception)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
          $"Not a readable Excel 97-2003 (.xls) file: {path} ({exception.Message})");
      }

      return BuildTextResult(
        path,
        "xls",
        text,
        MaxTextChars,
        $"Excel 97-2003 binary (BIFF); first worksheet, tab-separated, first {maxRows} rows.");
    });
  }

  public static Task<object?> ReadPptxAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var maxChars = Clamp(PluginRuntime.GetOptionalInt(parameters, "maxChars") ?? DefaultMaxChars, 1, MaxTextChars);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var path = FileBoundary.ResolveImportPath(rawPath, ".pptx");
      var budget = new ZipReadBudget();
      using var archive = OpenZip(path);

      var slides = EnumerateEntries(archive)
        .Where(entry => entry.FullName.StartsWith("ppt/slides/slide", StringComparison.Ordinal)
          && entry.FullName.EndsWith(".xml", StringComparison.Ordinal))
        .OrderBy(entry => entry.FullName, StringComparer.Ordinal)
        .ToList();

      if (slides.Count == 0)
      {
        throw new JsonRpcDispatchException("CIVIL3D.FILE_TYPE_NOT_ALLOWED", $"Not a valid .pptx file (no slides found): {path}");
      }

      var builder = new StringBuilder();
      var index = 0;
      foreach (var entry in slides)
      {
        var xml = ReadEntryText(entry, budget);
        builder.Append("--- slide ").Append(++index).AppendLine(" ---");
        foreach (Match match in Regex.Matches(xml, @"<a:t>(.*?)</a:t>", RegexOptions.Singleline))
        {
          builder.AppendLine(WebUtility.HtmlDecode(match.Groups[1].Value));
        }
      }

      return BuildTextResult(
        path,
        "pptx",
        builder.ToString(),
        maxChars,
        $"{slides.Count} slides, text runs only.",
        $"At most {MaxZipEntries} archive entries are scanned for slides.");
    });
  }

  public static Task<object?> ReadZipAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var entryName = PluginRuntime.GetOptionalString(parameters, "entry");

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var path = FileBoundary.ResolveImportPath(rawPath, ".zip");
      using var archive = OpenZip(path);

      if (string.IsNullOrWhiteSpace(entryName))
      {
        return ListZipEntries(path, archive);
      }

      return ReadZipEntry(path, archive, entryName);
    });
  }

  // ---------------------------------------------------------------------------
  // Zip listing and single-entry text extraction
  // ---------------------------------------------------------------------------

  private static object ListZipEntries(string path, ZipArchive archive)
  {
    var entries = new List<object?>();
    var truncated = false;

    foreach (var entry in archive.Entries)
    {
      if (string.IsNullOrEmpty(entry.Name))
      {
        continue; // directory entry
      }

      if (entries.Count >= MaxZipEntries)
      {
        truncated = true;
        break;
      }

      entries.Add(new Dictionary<string, object?>
      {
        ["name"] = entry.FullName,
        ["size"] = entry.Length,
        ["compressedSize"] = entry.CompressedLength,
      });
    }

    return new Dictionary<string, object?>
    {
      ["path"] = path,
      ["mode"] = "listing",
      ["count"] = entries.Count,
      ["truncated"] = truncated,
      ["entries"] = entries,
      ["notes"] = new List<string>
      {
        $"Entry listing is capped at {MaxZipEntries} entries.",
        "To read one text entry, pass its name as entry.",
        "Nothing was extracted to disk.",
      },
    };
  }

  private static object ReadZipEntry(string path, ZipArchive archive, string entryName)
  {
    ZipArchiveEntry? target = null;
    foreach (var entry in archive.Entries)
    {
      if (string.Equals(entry.FullName, entryName, StringComparison.Ordinal)
        || string.Equals(entry.Name, entryName, StringComparison.Ordinal))
      {
        target = entry;
        break;
      }
    }

    if (target == null)
    {
      throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Entry not found in the zip archive: {entryName}");
    }

    if (target.Length > MaxZipTextEntryBytes)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_TOO_LARGE",
        $"Entry '{target.FullName}' is {target.Length} bytes; the text limit is {MaxZipTextEntryBytes}.");
    }

    // ReadEntryText enforces the caps again while decompressing, so a lying
    // Length header cannot get past them.
    var content = ReadEntryText(target, new ZipReadBudget());
    if (content.IndexOf('\0') >= 0)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
        $"Entry '{target.FullName}' is binary, not readable as text.");
    }

    var truncated = content.Length > DefaultMaxChars;
    return new Dictionary<string, object?>
    {
      ["path"] = path,
      ["mode"] = "entry",
      ["entry"] = target.FullName,
      ["size"] = target.Length,
      ["truncated"] = truncated,
      ["content"] = truncated ? content[..DefaultMaxChars] : content,
      ["notes"] = new List<string>
      {
        $"Text entries are capped at {MaxZipTextEntryBytes} decompressed bytes and {DefaultMaxChars} returned characters.",
        "Nothing was extracted to disk.",
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Archive plumbing
  // ---------------------------------------------------------------------------

  private static ZipArchive OpenZip(string path)
  {
    var length = new FileInfo(path).Length;
    if (length > MaxFileBytes)
    {
      throw new JsonRpcDispatchException("CIVIL3D.FILE_TOO_LARGE", $"File is {length} bytes; the limit is {MaxFileBytes}: {path}");
    }

    try
    {
      // FileBoundary.ResolveImportPath has already canonicalized the path, checked
      // the root, the extension and existence; this only opens it for reading.
      return new ZipArchive(File.OpenRead(path), ZipArchiveMode.Read, leaveOpen: false);
    }
    catch (IOException exception)
    {
      throw new JsonRpcDispatchException("CIVIL3D.FILE_IO_ERROR", $"Unable to open '{path}': {exception.Message}");
    }
    catch (InvalidDataException exception)
    {
      throw new JsonRpcDispatchException("CIVIL3D.FILE_TYPE_NOT_ALLOWED", $"Not a valid zip container: {path} ({exception.Message})");
    }
  }

  private static IEnumerable<ZipArchiveEntry> EnumerateEntries(ZipArchive archive)
  {
    var count = 0;
    foreach (var entry in archive.Entries)
    {
      if (++count > MaxZipEntries)
      {
        break;
      }

      yield return entry;
    }
  }

  private static string? ReadArchiveText(ZipArchive archive, string entryName, ZipReadBudget budget)
  {
    var entry = archive.GetEntry(entryName);
    return entry == null ? null : ReadEntryText(entry, budget);
  }

  /// <summary>
  /// Read one entry as UTF-8 text without ever writing it to disk. The
  /// per-entry cap and the running total cap are applied while decompressing,
  /// so a declared size that lies smaller than the real stream cannot pass.
  /// </summary>
  private static string ReadEntryText(ZipArchiveEntry entry, ZipReadBudget budget)
  {
    if (entry.Length > MaxDecompressedEntryBytes)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_TOO_LARGE",
        $"Archive entry '{entry.FullName}' declares {entry.Length} bytes; the per-entry limit is {MaxDecompressedEntryBytes}.");
    }

    try
    {
      using var source = entry.Open();
      using var buffer = new MemoryStream();
      var chunk = new byte[81920];
      long entryTotal = 0;
      int read;
      while ((read = source.Read(chunk, 0, chunk.Length)) > 0)
      {
        entryTotal += read;
        budget.Total += read;
        if (entryTotal > MaxDecompressedEntryBytes)
        {
          throw new JsonRpcDispatchException(
            "CIVIL3D.FILE_TOO_LARGE",
            $"Archive entry '{entry.FullName}' exceeds the per-entry limit of {MaxDecompressedEntryBytes} decompressed bytes.");
        }

        if (budget.Total > MaxDecompressedTotalBytes)
        {
          throw new JsonRpcDispatchException(
            "CIVIL3D.FILE_TOO_LARGE",
            $"The archive exceeds the total limit of {MaxDecompressedTotalBytes} decompressed bytes.");
        }

        buffer.Write(chunk, 0, read);
      }

      return Encoding.UTF8.GetString(buffer.ToArray());
    }
    catch (InvalidDataException exception)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
        $"Archive entry '{entry.FullName}' is corrupt: {exception.Message}");
    }
    catch (IOException exception)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_IO_ERROR",
        $"Unable to read archive entry '{entry.FullName}': {exception.Message}");
    }
  }

  private static byte[] ReadAllBytes(string path)
  {
    try
    {
      var length = new FileInfo(path).Length;
      if (length > MaxFileBytes)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.FILE_TOO_LARGE",
          $"File is {length} bytes; the limit is {MaxFileBytes}: {path}");
      }

      using var buffer = new MemoryStream();
      using (var stream = File.OpenRead(path))
      {
        stream.CopyTo(buffer);
      }

      return buffer.ToArray();
    }
    catch (IOException exception)
    {
      throw new JsonRpcDispatchException("CIVIL3D.FILE_IO_ERROR", $"Unable to read '{path}': {exception.Message}");
    }
  }

  private sealed class ZipReadBudget
  {
    public long Total { get; set; }
  }

  // ---------------------------------------------------------------------------
  // OOXML text extraction
  // ---------------------------------------------------------------------------

  private static string ExtractDocxText(string path)
  {
    using var archive = OpenZip(path);
    var xml = ReadArchiveText(archive, "word/document.xml", new ZipReadBudget())
      ?? throw new JsonRpcDispatchException(
        "CIVIL3D.FILE_TYPE_NOT_ALLOWED",
        $"Not a valid .docx file (word/document.xml is missing): {path}");

    var text = Regex.Replace(xml, @"</w:p>", "\n");
    text = Regex.Replace(text, @"<[^>]+>", string.Empty);
    return WebUtility.HtmlDecode(text);
  }

  private static List<string> ParseSharedStrings(string xml)
  {
    var list = new List<string>();
    foreach (Match item in Regex.Matches(xml, @"<si>(.*?)</si>", RegexOptions.Singleline))
    {
      var builder = new StringBuilder();
      foreach (Match run in Regex.Matches(item.Groups[1].Value, @"<t[^>]*>(.*?)</t>", RegexOptions.Singleline))
      {
        builder.Append(WebUtility.HtmlDecode(run.Groups[1].Value));
      }

      list.Add(builder.ToString());
    }

    return list;
  }

  private static string ParseSheet(string xml, List<string> shared, int maxRows)
  {
    var builder = new StringBuilder();
    var rowCount = 0;

    foreach (Match row in Regex.Matches(xml, @"<row[^>]*>(.*?)</row>", RegexOptions.Singleline))
    {
      if (rowCount >= maxRows)
      {
        builder.AppendLine("... (truncated at " + maxRows + " rows)");
        break;
      }

      rowCount++;
      var cells = new List<string>();
      foreach (Match cell in Regex.Matches(row.Groups[1].Value, @"<c[^>]*>(.*?)</c>", RegexOptions.Singleline))
      {
        var typeMatch = Regex.Match(cell.Groups[0].Value, "t=\"([^\"]+)\"");
        var valueMatch = Regex.Match(cell.Groups[1].Value, @"<v>(.*?)</v>", RegexOptions.Singleline);
        if (!valueMatch.Success)
        {
          cells.Add(string.Empty);
          continue;
        }

        var value = WebUtility.HtmlDecode(valueMatch.Groups[1].Value);
        if (typeMatch.Success && typeMatch.Groups[1].Value == "s")
        {
          if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
            && index >= 0 && index < shared.Count)
          {
            cells.Add(shared[index]);
          }
          else
          {
            cells.Add(string.Empty);
          }
        }
        else
        {
          cells.Add(value);
        }
      }

      builder.AppendLine(string.Join("\t", cells));
    }

    return builder.ToString();
  }

  // ---------------------------------------------------------------------------
  // Shared result shaping
  // ---------------------------------------------------------------------------

  private static object BuildTextResult(string path, string format, string text, int maxChars, params string[] extraNotes)
  {
    var truncated = text.Length > maxChars;
    var notes = new List<string>
    {
      $"Text is capped at {maxChars} of {text.Length} characters; raise maxChars to read more.",
    };
    notes.AddRange(extraNotes);

    return new Dictionary<string, object?>
    {
      ["path"] = path,
      ["format"] = format,
      ["totalChars"] = text.Length,
      ["truncated"] = truncated,
      ["content"] = truncated ? text[..maxChars] : text,
      ["notes"] = notes,
    };
  }

  private static int Clamp(int value, int min, int max) => Math.Min(Math.Max(value, min), max);
}
