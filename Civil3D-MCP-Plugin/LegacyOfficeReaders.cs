using System.Globalization;
using System.Text;

namespace Civil3DMcpPlugin;

/// <summary>
/// Zero-dependency readers for the legacy Office binary formats:
///
///   Word 97-2003  (.doc) -> WordDocument stream + table stream (CLX / piece table)
///   Excel 97-2003 (.xls) -> Workbook/Book stream (BIFF8 records, first worksheet)
///
/// Only BCL types are used: no NuGet package, no AutoCAD type, no Office COM.
/// The two callers are <see cref="FileFormatCommands.ReadDocAsync"/> and
/// <see cref="FileFormatCommands.ReadXlsAsync"/>, which have already passed the
/// path through FileBoundary.ResolveImportPath and read the bytes in memory.
/// Nothing here opens a file, and nothing here writes one.
///
/// Malformed input is rejected with <see cref="InvalidDataException"/>; the
/// caller turns that into CIVIL3D.FILE_TYPE_NOT_ALLOWED.
/// </summary>
internal static class LegacyOfficeReaders
{
  /// <summary>Appended when the worksheet is truncated by maxRows. ASCII only: this string reaches a model.</summary>
  private const string TruncationMarker = "... (truncated)";

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /// <summary>Extract the plain text of a Word 97-2003 (.doc) file.</summary>
  public static string ReadDocText(byte[] file)
  {
    if (file == null) throw new ArgumentNullException(nameof(file));
    if (file.Length == 0) throw new InvalidDataException("Empty file.");

    var compound = new CfbDocument(file);
    var wordDocument = compound.GetStreamRequired("WordDocument");
    if (wordDocument.Length < 0x40) throw new InvalidDataException("WordDocument stream is too small.");

    var wIdent = BitConverter.ToUInt16(wordDocument, 0);
    if (wIdent != 0xA5EC) throw new InvalidDataException("Not a Word binary document (bad wIdent).");

    var nFib = BitConverter.ToUInt16(wordDocument, 2);
    if (nFib < 0x00C1)
    {
      throw new InvalidDataException(
        "Unsupported Word version (nFib=0x" + nFib.ToString("X4", CultureInfo.InvariantCulture) + "); Word 97 or newer is required.");
    }

    var fibFlags = BitConverter.ToUInt16(wordDocument, 10);
    if ((fibFlags & 0x0100) != 0) throw new InvalidDataException("Encrypted .doc files are not supported.");

    var whichTableStream = (fibFlags & 0x0200) != 0;
    var tableName = whichTableStream ? "1Table" : "0Table";
    var table = compound.GetStream(tableName);
    if (table == null)
    {
      table = compound.GetStream(whichTableStream ? "0Table" : "1Table");
      if (table == null) throw new InvalidDataException("Table stream ('" + tableName + "') not found.");
    }

    // Locate FibRgFcLcb97:
    //   FibBase(32) + [csw(2) + FibRgW97] + [cslw(2) + FibRgLw97] + cbRgFcLcb(2) + pairs(8 bytes each).
    var csw = BitConverter.ToUInt16(wordDocument, 0x20);
    var offset = 0x22 + csw * 2;
    if (offset + 2 > wordDocument.Length) throw new InvalidDataException("Malformed FIB (cslw).");
    var cslw = BitConverter.ToUInt16(wordDocument, offset);
    offset += 2 + cslw * 4;
    offset += 2; // skip cbRgFcLcb
    var fcClxOffset = offset + 66 * 4; // fcClx is the 67th (fc, lcb) pair in FibRgFcLcb97
    if (fcClxOffset + 8 > wordDocument.Length) throw new InvalidDataException("Malformed FIB (fcClx).");

    var fcClx = BitConverter.ToInt32(wordDocument, fcClxOffset);
    var lcbClx = BitConverter.ToInt32(wordDocument, fcClxOffset + 4);
    if (fcClx <= 0 || lcbClx <= 0 || fcClx + lcbClx > table.Length)
    {
      throw new InvalidDataException("Invalid CLX location in the table stream.");
    }

    var ccpText = 0;
    if (0x4C + 4 <= wordDocument.Length) ccpText = BitConverter.ToInt32(wordDocument, 0x4C);
    if (ccpText < 0) ccpText = 0;

    var pieces = ParseClx(table, fcClx, lcbClx);
    if (pieces.Count == 0) throw new InvalidDataException("No text pieces found in the CLX.");

    var builder = new StringBuilder(ccpText > 0 && ccpText < 4_000_000 ? ccpText : 4096);
    var produced = 0;
    var fieldDepth = 0;
    var inFieldCode = false;

    foreach (var piece in pieces)
    {
      var length = piece.CpEnd - piece.CpStart;
      if (length <= 0) continue;

      for (var i = 0; i < length; i++)
      {
        if (ccpText > 0 && produced >= ccpText) break;
        produced++;

        char character;
        if (piece.Compressed)
        {
          var index = piece.Fc + i;
          character = index >= 0 && index < wordDocument.Length ? (char)wordDocument[index] : '\uFFFD';
        }
        else
        {
          var index = piece.Fc + i * 2;
          character = index >= 0 && index + 1 < wordDocument.Length
            ? (char)(wordDocument[index] | (wordDocument[index + 1] << 8))
            : '\uFFFD';
        }

        // Field markers: 0x13 begin, 0x14 separator, 0x15 end.
        if (character == '\u0013')
        {
          fieldDepth++;
          if (fieldDepth == 1) inFieldCode = true;
          continue;
        }

        if (character == '\u0014')
        {
          if (fieldDepth > 0) inFieldCode = false;
          continue;
        }

        if (character == '\u0015')
        {
          if (fieldDepth > 0) fieldDepth--;
          if (fieldDepth == 0) inFieldCode = false;
          continue;
        }

        if (inFieldCode) continue;

        switch (character)
        {
          case '\r':     // paragraph end
          case '\u000B': // manual line break
          case '\u000C': // page or section break
            builder.Append('\n');
            break;
          case '\u0007': // cell or row mark
          case '\t':
            builder.Append('\t');
            break;
          case '\u00A0': // non-breaking space
            builder.Append(' ');
            break;
          case '\uFFFC': // inline object placeholder
            break;
          default:
            if (character >= 0x20) builder.Append(character);
            break;
        }
      }

      if (ccpText > 0 && produced >= ccpText) break;
    }

    return builder.ToString();
  }

  /// <summary>
  /// Extract the text of the first worksheet of an Excel 97-2003 (.xls) file.
  /// Cells within a row are separated by TAB, rows by LF. When maxRows &gt; 0 the
  /// output stops after that many rows and a truncation marker line is appended;
  /// maxRows &lt;= 0 means "all rows".
  /// </summary>
  public static string ReadXlsText(byte[] file, int maxRows)
  {
    if (file == null) throw new ArgumentNullException(nameof(file));
    if (file.Length == 0) throw new InvalidDataException("Empty file.");

    var compound = new CfbDocument(file);
    var workbook = compound.GetStream("Workbook") ?? compound.GetStream("Book");
    if (workbook == null) throw new InvalidDataException("Workbook/Book stream not found.");
    if (workbook.Length < 8) throw new InvalidDataException("Workbook stream is too small.");

    return XlsWorkbook.ReadFirstSheet(workbook, maxRows);
  }

  // ---------------------------------------------------------------------------
  // .doc CLX / piece table
  // ---------------------------------------------------------------------------

  private readonly struct TextPiece
  {
    public readonly int CpStart;
    public readonly int CpEnd;
    public readonly int Fc;
    public readonly bool Compressed;

    public TextPiece(int cpStart, int cpEnd, int fc, bool compressed)
    {
      CpStart = cpStart;
      CpEnd = cpEnd;
      Fc = fc;
      Compressed = compressed;
    }
  }

  private static List<TextPiece> ParseClx(byte[] table, int fcClx, int lcbClx)
  {
    var result = new List<TextPiece>();
    var end = fcClx + lcbClx;
    var position = fcClx;

    while (position < end)
    {
      var kind = table[position];
      if (kind == 0x01)
      {
        // clxtGrpprl: 2-byte size + grpprl
        if (position + 3 > end) break;
        var size = BitConverter.ToUInt16(table, position + 1);
        position += 3 + size;
      }
      else if (kind == 0x02)
      {
        // clxtPlcfpcd: 4-byte size + PlcPcd
        if (position + 5 > end) break;
        var length = BitConverter.ToInt32(table, position + 1);
        position += 5;
        if (length < 4 || position + length > table.Length) throw new InvalidDataException("PlcPcd out of range.");

        var count = (length - 4) / 12;
        if (count > 0)
        {
          var baseOffset = position;
          for (var i = 0; i < count; i++)
          {
            var cpStart = BitConverter.ToInt32(table, baseOffset + i * 4);
            var cpEnd = BitConverter.ToInt32(table, baseOffset + (i + 1) * 4);
            var pcdOffset = baseOffset + (count + 1) * 4 + i * 8;
            var fcRaw = BitConverter.ToInt32(table, pcdOffset + 2);
            var fc = fcRaw & 0x3FFFFFFF;
            var compressed = (fcRaw & 0x40000000) != 0;
            if (compressed) fc /= 2;
            result.Add(new TextPiece(cpStart, cpEnd, fc, compressed));
          }
        }

        position += length;
      }
      else
      {
        break;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // .xls BIFF8
  // ---------------------------------------------------------------------------

  private static class XlsWorkbook
  {
    private const int Bof = 0x0809;
    private const int Eof = 0x000A;
    private const int BoundSheet = 0x0085;
    private const int Continue = 0x003C;
    private const int Sst = 0x00FC;
    private const int LabelSst = 0x00FD;
    private const int Label = 0x0204;
    private const int Number = 0x0203;
    private const int Rk = 0x027E;
    private const int MulRk = 0x00BD;
    private const int Formula = 0x0006;
    private const int StringRecord = 0x0207;

    public static string ReadFirstSheet(byte[] workbook, int maxRows)
    {
      var biff5 = false;
      if (BitConverter.ToUInt16(workbook, 0) == Bof && workbook.Length >= 8)
      {
        biff5 = BitConverter.ToUInt16(workbook, 4) < 0x0600;
      }

      var sheets = new List<SheetRef>();
      List<byte[]>? sstSegments = null;

      var position = 0;
      while (position + 4 <= workbook.Length)
      {
        var id = BitConverter.ToUInt16(workbook, position);
        var length = BitConverter.ToUInt16(workbook, position + 2);
        var dataOffset = position + 4;
        if (dataOffset + length > workbook.Length) break;

        if (id == BoundSheet && length >= 8)
        {
          var streamPosition = BitConverter.ToInt32(workbook, dataOffset);
          var nameLength = workbook[dataOffset + 6];
          var flags = workbook[dataOffset + 7];
          var nameOffset = dataOffset + 8;
          string name;
          if ((flags & 0x01) != 0)
          {
            var characters = Math.Min(nameLength, Math.Max(0, (length - 8) / 2));
            name = Encoding.Unicode.GetString(workbook, nameOffset, characters * 2);
          }
          else
          {
            var characters = Math.Min(nameLength, Math.Max(0, length - 8));
            name = Encoding.Latin1.GetString(workbook, nameOffset, characters);
          }

          sheets.Add(new SheetRef(streamPosition, name));
        }
        else if (id == Sst)
        {
          sstSegments = new List<byte[]> { Slice(workbook, dataOffset, length) };
          var next = dataOffset + length;
          while (next + 4 <= workbook.Length && BitConverter.ToUInt16(workbook, next) == Continue)
          {
            var continueLength = BitConverter.ToUInt16(workbook, next + 2);
            sstSegments.Add(Slice(workbook, next + 4, continueLength));
            next += 4 + continueLength;
          }
        }

        position = dataOffset + length;
      }

      // BIFF5 has no SST: every string is inline in a LABEL record.
      List<string> sharedStrings = sstSegments == null || biff5 ? new List<string>() : ParseSst(sstSegments);
      if (sheets.Count == 0) throw new InvalidDataException("No worksheet (BOUNDSHEET) found in the workbook.");

      var rows = new SortedDictionary<int, SortedDictionary<int, string>>();
      ParseSheet(workbook, sheets[0].Position, sharedStrings, biff5, rows);
      return FormatRows(rows, maxRows);
    }

    private readonly struct SheetRef
    {
      public readonly int Position;
      public readonly string Name;

      public SheetRef(int position, string name)
      {
        Position = position;
        Name = name;
      }
    }

    private static List<string> ParseSst(List<byte[]> segments)
    {
      var reader = new SstReader(segments);
      var total = reader.ReadInt32();
      var unique = reader.ReadInt32();
      if (unique < 0 || unique > 20_000_000)
      {
        throw new InvalidDataException("Invalid SST unique count (" + unique.ToString(CultureInfo.InvariantCulture) + ").");
      }

      _ = total;
      var list = new List<string>(unique);
      for (var i = 0; i < unique; i++) list.Add(reader.ReadString());
      return list;
    }

    private static void ParseSheet(
      byte[] workbook,
      int start,
      List<string> sharedStrings,
      bool biff5,
      SortedDictionary<int, SortedDictionary<int, string>> rows)
    {
      var position = start;
      var pendingRow = -1;
      var pendingColumn = -1;
      var pendingFormulaString = false;

      while (position + 4 <= workbook.Length)
      {
        var id = BitConverter.ToUInt16(workbook, position);
        var length = BitConverter.ToUInt16(workbook, position + 2);
        var dataOffset = position + 4;
        if (dataOffset + length > workbook.Length) break;
        if (id == Eof) break;

        switch (id)
        {
          case LabelSst:
            if (length >= 10)
            {
              var row = BitConverter.ToUInt16(workbook, dataOffset);
              var column = BitConverter.ToUInt16(workbook, dataOffset + 2);
              var index = BitConverter.ToInt32(workbook, dataOffset + 6);
              SetCell(rows, row, column, index >= 0 && index < sharedStrings.Count ? sharedStrings[index] : string.Empty);
            }

            break;

          case Label:
            if (length >= 8)
            {
              var row = BitConverter.ToUInt16(workbook, dataOffset);
              var column = BitConverter.ToUInt16(workbook, dataOffset + 2);
              var value = biff5
                ? ReadBiff5String(workbook, dataOffset + 6, length - 6)
                : ReadXlUnicodeString(workbook, dataOffset + 6, length - 6);
              SetCell(rows, row, column, value);
            }

            break;

          case Rk:
            if (length >= 10)
            {
              var row = BitConverter.ToUInt16(workbook, dataOffset);
              var column = BitConverter.ToUInt16(workbook, dataOffset + 2);
              SetCell(rows, row, column, NumberToString(DecodeRk(BitConverter.ToInt32(workbook, dataOffset + 6))));
            }

            break;

          case MulRk:
            if (length >= 6)
            {
              var row = BitConverter.ToUInt16(workbook, dataOffset);
              var firstColumn = BitConverter.ToUInt16(workbook, dataOffset + 2);
              var count = (length - 6) / 6;
              for (var i = 0; i < count; i++)
              {
                var rkOffset = dataOffset + 4 + i * 6 + 2;
                if (rkOffset + 4 > dataOffset + length) break;
                SetCell(rows, row, firstColumn + i, NumberToString(DecodeRk(BitConverter.ToInt32(workbook, rkOffset))));
              }
            }

            break;

          case Number:
            if (length >= 14)
            {
              var row = BitConverter.ToUInt16(workbook, dataOffset);
              var column = BitConverter.ToUInt16(workbook, dataOffset + 2);
              SetCell(rows, row, column, NumberToString(BitConverter.ToDouble(workbook, dataOffset + 6)));
            }

            break;

          case Formula:
            if (length >= 14)
            {
              var row = BitConverter.ToUInt16(workbook, dataOffset);
              var column = BitConverter.ToUInt16(workbook, dataOffset + 2);
              pendingRow = row;
              pendingColumn = column;
              pendingFormulaString = true;
              SetCell(rows, row, column, NumberToString(BitConverter.ToDouble(workbook, dataOffset + 6)));
            }

            break;

          case StringRecord:
            if (pendingFormulaString && pendingRow >= 0)
            {
              var value = biff5
                ? ReadBiff5String(workbook, dataOffset, length)
                : ReadXlUnicodeString(workbook, dataOffset, length);
              SetCell(rows, pendingRow, pendingColumn, value);
              pendingFormulaString = false;
            }

            break;

          default:
            // A formula's string result is followed immediately by a STRING
            // record; any other intervening record cancels the pending state.
            if (id != Continue) pendingFormulaString = false;
            break;
        }

        position = dataOffset + length;
      }
    }

    /// <summary>BIFF8 XLUnicodeString: 2-byte character count, 1-byte grbit (bit 0 = 16-bit characters).</summary>
    private static string ReadXlUnicodeString(byte[] workbook, int offset, int maxLength)
    {
      if (maxLength < 3) return string.Empty;
      var characters = BitConverter.ToUInt16(workbook, offset);
      var flags = workbook[offset + 2];
      var position = offset + 3;
      if ((flags & 0x01) != 0)
      {
        var count = Math.Min(characters, (maxLength - 3) / 2);
        return count <= 0 ? string.Empty : Encoding.Unicode.GetString(workbook, position, count * 2);
      }

      var byteCount = Math.Min(characters, maxLength - 3);
      return byteCount <= 0 ? string.Empty : Encoding.Latin1.GetString(workbook, position, byteCount);
    }

    /// <summary>BIFF5 byte string: 1-byte character count, Latin-1 characters.</summary>
    private static string ReadBiff5String(byte[] workbook, int offset, int maxLength)
    {
      if (maxLength < 1) return string.Empty;
      var count = Math.Min(workbook[offset], maxLength - 1);
      return count <= 0 ? string.Empty : Encoding.Latin1.GetString(workbook, offset + 1, count);
    }

    private static void SetCell(SortedDictionary<int, SortedDictionary<int, string>> rows, int row, int column, string value)
    {
      if (row < 0 || column < 0) return;
      if (!rows.TryGetValue(row, out var columns))
      {
        columns = new SortedDictionary<int, string>();
        rows[row] = columns;
      }

      columns[column] = value;
    }

    private static string FormatRows(SortedDictionary<int, SortedDictionary<int, string>> rows, int maxRows)
    {
      var lines = new List<string>();
      var truncated = false;
      var count = 0;

      foreach (var row in rows)
      {
        if (maxRows > 0 && count >= maxRows)
        {
          truncated = true;
          break;
        }

        var builder = new StringBuilder();
        var first = true;
        foreach (var cell in row.Value)
        {
          if (!first) builder.Append('\t');
          builder.Append(cell.Value);
          first = false;
        }

        lines.Add(builder.ToString());
        count++;
      }

      if (truncated) lines.Add(TruncationMarker);
      return string.Join("\n", lines);
    }

    private static double DecodeRk(int rk)
    {
      var divideByHundred = (rk & 0x01) != 0;
      var isInteger = (rk & 0x02) != 0;
      double value;
      if (isInteger)
      {
        value = rk >> 2; // arithmetic shift -> signed 30-bit integer
      }
      else
      {
        var bits = ((long)(rk & unchecked((int)0xFFFFFFFC))) << 32;
        value = BitConverter.Int64BitsToDouble(bits);
      }

      if (divideByHundred) value /= 100.0;
      return value;
    }

    private static string NumberToString(double value)
    {
      if (double.IsNaN(value) || double.IsInfinity(value)) return string.Empty;
      if (value == Math.Floor(value) && Math.Abs(value) < 1e15)
      {
        return ((long)value).ToString(CultureInfo.InvariantCulture);
      }

      return value.ToString("R", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Streaming reader over the SST and its CONTINUE segments. When a string's
    /// character data continues into a CONTINUE record, that record starts with
    /// a 1-byte grbit (fHighByte) that must be consumed before the rest.
    /// </summary>
    private sealed class SstReader
    {
      private readonly List<byte[]> _segments;
      private int _segment;
      private int _position;

      public SstReader(List<byte[]> segments)
      {
        _segments = segments;
        _segment = 0;
        _position = 0;
      }

      private bool Advance()
      {
        while (_position >= _segments[_segment].Length)
        {
          if (_segment + 1 >= _segments.Count) return false;
          _segment++;
          _position = 0;
        }

        return true;
      }

      private byte ReadByte()
      {
        if (!Advance()) throw new InvalidDataException("SST record truncated.");
        return _segments[_segment][_position++];
      }

      public ushort ReadUInt16()
      {
        var low = ReadByte();
        var high = ReadByte();
        return (ushort)(low | (high << 8));
      }

      public int ReadInt32()
      {
        var b0 = ReadByte();
        var b1 = ReadByte();
        var b2 = ReadByte();
        var b3 = ReadByte();
        return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
      }

      private void Skip(int count)
      {
        for (var i = 0; i < count; i++) ReadByte();
      }

      public string ReadString()
      {
        var characterCount = ReadUInt16();
        var flags = ReadByte();
        var highByte = (flags & 0x01) != 0;
        var extended = (flags & 0x04) != 0;
        var rich = (flags & 0x08) != 0;
        var runCount = rich ? ReadUInt16() : 0;
        var extendedSize = extended ? ReadInt32() : 0;

        var builder = new StringBuilder(characterCount);
        for (var i = 0; i < characterCount; i++)
        {
          // Crossing a record boundary: the CONTINUE record begins with a grbit byte.
          if (_position >= _segments[_segment].Length)
          {
            if (_segment + 1 >= _segments.Count) throw new InvalidDataException("SST string truncated.");
            _segment++;
            _position = 0;
            highByte = (_segments[_segment][_position++] & 0x01) != 0;
          }

          if (highByte)
          {
            if (_position + 2 > _segments[_segment].Length)
            {
              if (_segment + 1 >= _segments.Count) throw new InvalidDataException("SST UTF-16 character truncated.");
              _segment++;
              _position = 0;
              highByte = (_segments[_segment][_position++] & 0x01) != 0;
            }

            var low = _segments[_segment][_position++];
            var high = _segments[_segment][_position++];
            builder.Append((char)(low | (high << 8)));
          }
          else
          {
            builder.Append((char)_segments[_segment][_position++]);
          }
        }

        if (rich) Skip(runCount * 4);
        if (extended) Skip(extendedSize);
        return builder.ToString();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // OLE2 / Compound File Binary reader
  // ---------------------------------------------------------------------------

  private sealed class CfbDocument
  {
    private const uint FreeSector = 0xFFFFFFFF;
    private const uint EndOfChain = 0xFFFFFFFE;

    /// <summary>Guard against a cyclic FAT chain: no real file has this many sectors.</summary>
    private const int MaxChainSectors = 10_000_000;

    /// <summary>Guard against a cyclic DIFAT chain.</summary>
    private const int MaxDifatSectors = 4096;

    private readonly byte[] _data;
    private readonly int _sectorSize;
    private readonly int _miniSectorSize;
    private readonly int _miniCutoff;
    private readonly uint[] _fat;
    private readonly uint[] _miniFat;
    private readonly byte[] _miniStream;
    private readonly List<CfbDirEntry> _entries = new List<CfbDirEntry>();

    public CfbDocument(byte[] data)
    {
      _data = data;

      if (data.Length < 512) throw new InvalidDataException("Not an OLE2 file (too small).");
      if (BitConverter.ToUInt32(data, 0) != 0xE011CFD0 || BitConverter.ToUInt32(data, 4) != 0xE11AB1A1)
      {
        throw new InvalidDataException("Not an OLE2 compound document (bad signature).");
      }

      var sectorShift = BitConverter.ToUInt16(data, 30);
      var miniSectorShift = BitConverter.ToUInt16(data, 32);
      if (sectorShift != 9 && sectorShift != 12)
      {
        throw new InvalidDataException(
          "Unsupported OLE2 sector size (shift=" + sectorShift.ToString(CultureInfo.InvariantCulture) + ").");
      }

      if (miniSectorShift != 6)
      {
        throw new InvalidDataException(
          "Unsupported OLE2 mini sector size (shift=" + miniSectorShift.ToString(CultureInfo.InvariantCulture) + ").");
      }

      _sectorSize = 1 << sectorShift;
      _miniSectorSize = 1 << miniSectorShift;

      var firstDirectorySector = (int)BitConverter.ToUInt32(data, 48);
      _miniCutoff = (int)BitConverter.ToUInt32(data, 56);
      var firstMiniFatSector = (int)BitConverter.ToUInt32(data, 60);
      var miniFatSectorCount = (int)BitConverter.ToUInt32(data, 64);
      var firstDifatSector = (int)BitConverter.ToUInt32(data, 68);
      if (_miniCutoff <= 0) _miniCutoff = 4096;

      // Gather the FAT sector numbers from the header DIFAT and any DIFAT sectors.
      var fatSectors = new List<int>();
      for (var i = 0; i < 109; i++)
      {
        var value = BitConverter.ToUInt32(data, 76 + i * 4);
        if (value == FreeSector || value == EndOfChain) continue;
        fatSectors.Add((int)value);
      }

      var difatSector = firstDifatSector;
      var guard = 0;
      while (IsSector(difatSector) && guard++ < MaxDifatSectors)
      {
        var offset = SectorOffset(difatSector);
        if (offset + _sectorSize > data.Length) break;
        var entriesPerSector = _sectorSize / 4 - 1;
        for (var i = 0; i < entriesPerSector; i++)
        {
          var value = BitConverter.ToUInt32(data, offset + i * 4);
          if (value != FreeSector && value != EndOfChain) fatSectors.Add((int)value);
        }

        difatSector = (int)BitConverter.ToUInt32(data, offset + entriesPerSector * 4);
      }

      _fat = new uint[fatSectors.Count * (_sectorSize / 4)];
      var fatIndex = 0;
      foreach (var fatSector in fatSectors)
      {
        var offset = SectorOffset(fatSector);
        if (offset + _sectorSize > data.Length) throw new InvalidDataException("FAT sector out of range.");
        for (var i = 0; i < _sectorSize / 4; i++) _fat[fatIndex++] = BitConverter.ToUInt32(data, offset + i * 4);
      }

      if (miniFatSectorCount > 0 && IsSector(firstMiniFatSector))
      {
        var miniFatBytes = ReadFatChain(firstMiniFatSector);
        _miniFat = new uint[miniFatBytes.Length / 4];
        for (var i = 0; i < _miniFat.Length; i++) _miniFat[i] = BitConverter.ToUInt32(miniFatBytes, i * 4);
      }
      else
      {
        _miniFat = Array.Empty<uint>();
      }

      var directory = ReadFatChain(firstDirectorySector);
      for (var offset = 0; offset + 128 <= directory.Length; offset += 128)
      {
        var entry = ParseDirectoryEntry(directory, offset);
        if (entry != null) _entries.Add(entry);
      }

      if (_entries.Count == 0) throw new InvalidDataException("The OLE2 directory is empty.");

      var root = _entries[0];
      _miniStream = root.Type == 5 && root.Size > 0 && IsSector((int)root.StartSector)
        ? ReadFatChain((int)root.StartSector)
        : Array.Empty<byte>();
    }

    private static bool IsSector(int sector) => sector >= 0 && (uint)sector < 0xFFFFFFFCu;

    private int SectorOffset(int sector) => (sector + 1) * _sectorSize;

    private byte[] ReadFatChain(int startSector)
    {
      if (!IsSector(startSector)) return Array.Empty<byte>();
      using var buffer = new MemoryStream();
      var sector = startSector;
      var guard = 0;
      while (IsSector(sector))
      {
        var offset = SectorOffset(sector);
        if (offset + _sectorSize > _data.Length) break;
        buffer.Write(_data, offset, _sectorSize);
        if (sector >= _fat.Length) break;
        sector = (int)_fat[sector];
        if (guard++ > MaxChainSectors) break;
      }

      return buffer.ToArray();
    }

    private static CfbDirEntry? ParseDirectoryEntry(byte[] directory, int offset)
    {
      var type = directory[offset + 66];
      if (type == 0) return null;

      var nameLengthBytes = BitConverter.ToUInt16(directory, offset + 64);
      var characters = nameLengthBytes / 2;
      if (characters > 0) characters -= 1; // exclude the trailing null
      if (characters < 0) characters = 0;
      if (characters > 31) characters = 31;
      var name = characters > 0 ? Encoding.Unicode.GetString(directory, offset, characters * 2) : string.Empty;

      var startSector = BitConverter.ToUInt32(directory, offset + 116);
      var size = BitConverter.ToUInt64(directory, offset + 120);
      if (type != 5 && size > 0x7FFFFFFF) size = 0x7FFFFFFF; // sanity guard: streams are read into memory
      return new CfbDirEntry(name, type, startSector, size);
    }

    public byte[]? GetStream(string name)
    {
      foreach (var entry in _entries)
      {
        if (entry.Type == 2 && string.Equals(entry.Name, name, StringComparison.OrdinalIgnoreCase))
        {
          return ReadEntry(entry);
        }
      }

      return null;
    }

    public byte[] GetStreamRequired(string name) =>
      GetStream(name) ?? throw new InvalidDataException("Stream not found: " + name);

    private byte[] ReadEntry(CfbDirEntry entry)
    {
      var size = (int)entry.Size;
      if (size <= 0) return Array.Empty<byte>();
      if (!IsSector((int)entry.StartSector)) return Array.Empty<byte>();

      if (size < _miniCutoff && entry.Type != 5)
      {
        // Mini stream: 64-byte sectors resolved through the MiniFAT.
        if (_miniFat.Length == 0) throw new InvalidDataException("The mini stream is referenced but the MiniFAT is empty.");
        using var buffer = new MemoryStream();
        var sector = (int)entry.StartSector;
        var guard = 0;
        while (IsSector(sector))
        {
          var offset = sector * _miniSectorSize;
          if (offset + _miniSectorSize > _miniStream.Length) break;
          buffer.Write(_miniStream, offset, _miniSectorSize);
          if (sector >= _miniFat.Length) break;
          sector = (int)_miniFat[sector];
          if (guard++ > MaxChainSectors) break;
        }

        var bytes = buffer.ToArray();
        if (bytes.Length > size) Array.Resize(ref bytes, size);
        return bytes;
      }
      else
      {
        var bytes = ReadFatChain((int)entry.StartSector);
        if (bytes.Length > size) Array.Resize(ref bytes, size);
        return bytes;
      }
    }
  }

  private sealed class CfbDirEntry
  {
    public readonly string Name;
    public readonly byte Type;
    public readonly uint StartSector;
    public readonly ulong Size;

    public CfbDirEntry(string name, byte type, uint startSector, ulong size)
    {
      Name = name;
      Type = type;
      StartSector = startSector;
      Size = size;
    }
  }

  private static byte[] Slice(byte[] source, int offset, int length)
  {
    if (offset < 0) offset = 0;
    if (offset > source.Length) return Array.Empty<byte>();
    if (offset + length > source.Length) length = source.Length - offset;
    if (length <= 0) return Array.Empty<byte>();
    var result = new byte[length];
    Buffer.BlockCopy(source, offset, result, 0, length);
    return result;
  }
}
