using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.Civil.ApplicationServices;

namespace Civil3DMcpPlugin;

/// <summary>
/// Globals exposed to a gated Roslyn script (P11 item 1). Every property is
/// accessible by name in the C# code the caller approves. Ported from
/// nezolder/civil3d-mcp-roslyn ScriptContext.cs (MIT); barbosaihan/civil3d-mcp
/// carries the same class.
/// </summary>
public class ScriptContext
{
  public Document Document { get; }
  public CivilDocument CivilDoc { get; }
  public Database Database { get; }
  public Transaction Transaction { get; }
  public Editor Editor { get; }

  public ScriptContext(
    Document document,
    CivilDocument civilDoc,
    Database database,
    Transaction transaction)
  {
    Document = document;
    CivilDoc = civilDoc;
    Database = database;
    Transaction = transaction;
    Editor = document.Editor;
  }
}
