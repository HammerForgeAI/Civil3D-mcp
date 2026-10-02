using System.Text;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;

namespace Civil3DMcpPlugin;

/// <summary>
/// Legend ("simbología y leyenda") commands.
///
/// ReadLegendTableAsync returns the raw cells of the drawing's Table entities — one table by
/// handle, or every table in model space. It carries no "which table is the legend" heuristic
/// on purpose: the caller decides from the real content instead of guessing by position or
/// size. That is the only legend command that needs the live drawing.
///
/// QcCheckLegendAsync is the civil3d_qc check_legend backend. It compares the legend rows
/// against the symbols the legend must describe — the block references actually present in
/// model space, or an explicit blockNames list — and reports both directions: symbols no
/// legend row describes, and legend rows nothing in the drawing matches. Matching is the
/// donor's rule (case-insensitive, whitespace/underscore/hyphen removed, substring either
/// way), so a legend written "GATE VALVE" still matches the block "GATE_VALVE_12IN".
///
/// Both commands are read-only. They never create, edit or erase an object, so nothing here
/// is gated or retried differently from the other listers.
/// </summary>
public static class LegendCommands
{
  private const int ReadTableDefaultLimit = 200;
  private const int ReadTableMaxLimit = 500;
  private const int CheckDefaultLimit = 500;
  private const int CheckMaxLimit = 2000;

  // -------------------------------------------------------------------------
  // readLegendTable
  // -------------------------------------------------------------------------

  public static Task<object?> ReadLegendTableAsync(JsonObject? parameters)
  {
    var handleText = PluginRuntime.GetOptionalString(parameters, "handle");
    var requestedLimit = PluginRuntime.GetOptionalInt(parameters, "limit") ?? ReadTableDefaultLimit;
    var limit = Math.Clamp(requestedLimit, 1, ReadTableMaxLimit);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var tables = new List<Dictionary<string, object?>>();

      if (!string.IsNullOrWhiteSpace(handleText))
      {
        tables.Add(SerializeLegendTable(ReadLegendTableByHandle(database, transaction, handleText!)));
        return new Dictionary<string, object?> { ["tables"] = tables };
      }

      foreach (var table in EnumerateModelSpaceTables(database, transaction, limit))
      {
        tables.Add(SerializeLegendTable(table));
      }

      return new Dictionary<string, object?> { ["tables"] = tables };
    });
  }

  // -------------------------------------------------------------------------
  // qcCheckLegend
  // -------------------------------------------------------------------------

  public static Task<object?> QcCheckLegendAsync(JsonObject? parameters)
  {
    var handleText = PluginRuntime.GetOptionalString(parameters, "handle");
    var requestedLimit = PluginRuntime.GetOptionalInt(parameters, "limit") ?? CheckDefaultLimit;
    var limit = Math.Clamp(requestedLimit, 1, CheckMaxLimit);
    var expectedSymbols = ReadExpectedSymbols(parameters);

    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      try
      {
        var legendTables = new List<Dictionary<string, object?>>();
        var legendRows = new List<List<string?>>();

        if (!string.IsNullOrWhiteSpace(handleText))
        {
          var table = ReadLegendTableByHandle(database, transaction, handleText!);
          legendTables.Add(SerializeLegendTable(table));
          legendRows.AddRange(ReadLegendRows(table));
        }
        else
        {
          foreach (var table in EnumerateModelSpaceTables(database, transaction, limit))
          {
            legendTables.Add(SerializeLegendTable(table));
            legendRows.AddRange(ReadLegendRows(table));
          }
        }

        var symbols = expectedSymbols ?? CollectDrawingBlockNames(database, transaction, limit);
        var findings = new List<Dictionary<string, object?>>();

        if (legendRows.Count == 0)
        {
          findings.Add(new Dictionary<string, object?>
          {
            ["severity"] = "error",
            ["type"] = "legend_table_missing",
            ["message"] = string.IsNullOrWhiteSpace(handleText)
              ? "No Table entity with legend rows was found in model space; the drawing has no legend to check."
              : $"Table '{handleText}' has no rows; there is no legend content to check.",
          });
        }

        var matchedRows = new HashSet<int>();
        var matchedSymbols = 0;

        foreach (var symbol in symbols)
        {
          var rowIndex = FindLegendRowForSymbol(legendRows, matchedRows, symbol);
          if (rowIndex < 0)
          {
            findings.Add(new Dictionary<string, object?>
            {
              ["severity"] = "warning",
              ["type"] = "legend_missing_symbol",
              ["symbol"] = symbol,
              ["message"] = $"Symbol '{symbol}' is present in the drawing but no legend row describes it.",
            });
            continue;
          }

          matchedRows.Add(rowIndex);
          matchedSymbols++;
        }

        for (var index = 0; index < legendRows.Count; index++)
        {
          if (matchedRows.Contains(index))
          {
            continue;
          }

          var rowText = string.Join(" | ", legendRows[index].Where(cell => !string.IsNullOrWhiteSpace(cell)));
          if (string.IsNullOrWhiteSpace(rowText))
          {
            continue;
          }

          findings.Add(new Dictionary<string, object?>
          {
            ["severity"] = "warning",
            ["type"] = "legend_unmatched_entry",
            ["rowIndex"] = index,
            ["rowText"] = rowText,
            ["message"] = $"Legend row {index} ('{rowText}') matches no symbol in the drawing.",
          });
        }

        return new Dictionary<string, object?>
        {
          ["legendTables"] = legendTables,
          ["legendTableCount"] = legendTables.Count,
          ["legendRowCount"] = legendRows.Count,
          ["symbolSource"] = expectedSymbols != null ? "blockNames" : "drawing",
          ["symbolCount"] = symbols.Count,
          ["matchedSymbolCount"] = matchedSymbols,
          ["findings"] = findings,
          ["totalViolations"] = findings.Count,
        };
      }
      catch (JsonRpcDispatchException)
      {
        throw;
      }
      catch (Exception ex)
      {
        throw new JsonRpcDispatchException("CIVIL3D.QC_ERROR", $"Error checking the drawing legend: {ex.Message}");
      }
    });
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private static List<string>? ReadExpectedSymbols(JsonObject? parameters)
  {
    if (PluginRuntime.GetParameter(parameters, "blockNames") is not JsonArray node || node.Count == 0)
    {
      return null;
    }

    var symbols = new List<string>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var item in node)
    {
      var value = item?.GetValue<string>();
      if (string.IsNullOrWhiteSpace(value))
      {
        continue;
      }

      if (seen.Add(value!))
      {
        symbols.Add(value!);
      }
    }

    return symbols.Count == 0 ? null : symbols;
  }

  private static ObjectId ResolveHandleId(Database database, string handleText)
  {
    long handleNumber;
    try
    {
      handleNumber = Convert.ToInt64(handleText, 16);
    }
    catch (Exception ex) when (ex is FormatException or OverflowException)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Handle '{handleText}' is not a valid hexadecimal handle.");
    }

    if (!database.TryGetObjectId(new Handle(handleNumber), out var objectId) || objectId.IsNull)
    {
      throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Object with handle '{handleText}' was not found.");
    }

    return objectId;
  }

  private static Table ReadLegendTableByHandle(Database database, Transaction transaction, string handleText)
  {
    var objectId = ResolveHandleId(database, handleText);
    if (transaction.GetObject(objectId, OpenMode.ForRead) is not Table table)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Object '{handleText}' is not a Table.");
    }

    return table;
  }

  private static IEnumerable<Table> EnumerateModelSpaceTables(Database database, Transaction transaction, int limit)
  {
    var modelSpace = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(
      transaction,
      CivilObjectUtils.GetModelSpaceBlockId(database, transaction),
      OpenMode.ForRead);

    var found = 0;
    foreach (ObjectId objectId in modelSpace)
    {
      if (found >= limit)
      {
        yield break;
      }

      if (transaction.GetObject(objectId, OpenMode.ForRead) is Table table)
      {
        found++;
        yield return table;
      }
    }
  }

  private static Dictionary<string, object?> SerializeLegendTable(Table table)
  {
    return new Dictionary<string, object?>
    {
      ["handle"] = table.Handle.ToString(),
      ["layer"] = table.Layer,
      ["rowCount"] = table.Rows.Count,
      ["columnCount"] = table.Columns.Count,
      ["rows"] = ReadLegendRows(table),
    };
  }

  private static List<List<string?>> ReadLegendRows(Table table)
  {
    var rows = new List<List<string?>>(table.Rows.Count);
    for (var row = 0; row < table.Rows.Count; row++)
    {
      var cells = new List<string?>(table.Columns.Count);
      for (var column = 0; column < table.Columns.Count; column++)
      {
        cells.Add(table.Cells[row, column].TextString);
      }

      rows.Add(cells);
    }

    return rows;
  }

  private static List<string> CollectDrawingBlockNames(Database database, Transaction transaction, int limit)
  {
    var modelSpace = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(
      transaction,
      CivilObjectUtils.GetModelSpaceBlockId(database, transaction),
      OpenMode.ForRead);

    var names = new List<string>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    foreach (ObjectId objectId in modelSpace)
    {
      if (names.Count >= limit)
      {
        break;
      }

      if (transaction.GetObject(objectId, OpenMode.ForRead) is not BlockReference blockReference)
      {
        continue;
      }

      var blockRecordId = blockReference.IsDynamicBlock ? blockReference.DynamicBlockTableRecord : blockReference.BlockTableRecord;
      var blockRecord = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(transaction, blockRecordId, OpenMode.ForRead);
      var name = blockRecord.Name;
      if (string.IsNullOrWhiteSpace(name))
      {
        continue;
      }

      if (seen.Add(name!))
      {
        names.Add(name!);
      }
    }

    return names;
  }

  /// <summary>
  /// Finds the first unused legend row that describes the symbol. The comparison is the
  /// donor's rule: both sides are lower-cased with whitespace, underscores and hyphens
  /// removed, and a row matches when either side contains the other.
  /// </summary>
  private static int FindLegendRowForSymbol(List<List<string?>> legendRows, HashSet<int> matchedRows, string symbol)
  {
    var normalizedSymbol = NormalizeLegendText(symbol);
    if (normalizedSymbol.Length == 0)
    {
      return -1;
    }

    for (var index = 0; index < legendRows.Count; index++)
    {
      if (matchedRows.Contains(index))
      {
        continue;
      }

      foreach (var cell in legendRows[index])
      {
        var normalizedCell = NormalizeLegendText(cell);
        if (normalizedCell.Length == 0)
        {
          continue;
        }

        if (normalizedCell.Contains(normalizedSymbol, StringComparison.Ordinal)
          || normalizedSymbol.Contains(normalizedCell, StringComparison.Ordinal))
        {
          return index;
        }
      }
    }

    return -1;
  }

  private static string NormalizeLegendText(string? text)
  {
    if (string.IsNullOrEmpty(text))
    {
      return string.Empty;
    }

    var builder = new StringBuilder(text.Length);
    foreach (var character in text)
    {
      if (char.IsWhiteSpace(character) || character == '_' || character == '-')
      {
        continue;
      }

      builder.Append(char.ToLowerInvariant(character));
    }

    return builder.ToString();
  }
}
