using System.Linq;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

// Creates, copies, renames, deletes and lists AutoCAD paper-space layouts. This is plain drawing
// structure (not a Civil3D object), added specifically so a firm's title-block sheet (border, logo,
// revision table) can be duplicated for a new sheet (e.g. C-300 -> C-301) in one fast, in-process
// call. Core Console (LAYOUT COPY / LAYOUT TEMPLATE via a .scr) was tried first and abandoned: once a
// drawing holds more than a couple of Civil3D custom objects (surfaces, profile views with many
// labels, pipe/pressure networks), accoreconsole's headless regen of those objects made even a plain
// layout duplication take many minutes or hang outright. This handler never shells out to Core
// Console; it uses LayoutManager + Database.DeepCloneObjects directly against the live session.
public static class LayoutCommands
{
  public static Task<object?> ListLayoutsAsync()
  {
    return CivilExecution.ReadAsync<object?>((doc, civilDoc, database, transaction) =>
    {
      var layouts = new List<Dictionary<string, object?>>();
      foreach (var entry in EnumerateLayouts(database, transaction))
      {
        layouts.Add(new Dictionary<string, object?>
        {
          ["name"] = entry.Layout.LayoutName,
          ["tabOrder"] = entry.Layout.TabOrder,
          ["isModelSpace"] = entry.Layout.LayoutName.Equals("Model", StringComparison.OrdinalIgnoreCase),
          ["handle"] = entry.Layout.Handle.ToString(),
        });
      }

      layouts.Sort((a, b) => Convert.ToInt32(a["tabOrder"]).CompareTo(Convert.ToInt32(b["tabOrder"])));
      return new Dictionary<string, object?> { ["layouts"] = layouts };
    });
  }

  public static Task<object?> CreateLayoutAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");

    return CivilExecution.ExecuteInCommandContextAsync<object?>(() =>
    {
      var doc = App.DocumentManager.MdiActiveDocument
        ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
      var database = doc.Database;
      using var documentLock = doc.LockDocument();

      using (var tr = database.TransactionManager.StartTransaction())
      {
        if (FindLayout(database, tr, name).Layout != null)
        {
          throw new JsonRpcDispatchException("CIVIL3D.CONFLICT", $"A layout named '{name}' already exists. Use acad_layout list to see the layouts in this drawing.");
        }
        tr.Commit();
      }

      var newLayoutId = LayoutManager.Current.CreateLayout(name);

      string handle;
      using (var tr = database.TransactionManager.StartTransaction())
      {
        var layout = CivilObjectUtils.GetRequiredObject<Layout>(tr, newLayoutId, OpenMode.ForRead);
        handle = layout.Handle.ToString();
        tr.Commit();
      }

      return Task.FromResult<object?>(new Dictionary<string, object?>
      {
        ["name"] = name,
        ["handle"] = handle,
        ["created"] = true,
      });
    });
  }

  public static Task<object?> CopyLayoutAsync(JsonObject? parameters)
  {
    var sourceLayoutName = PluginRuntime.GetRequiredString(parameters, "sourceLayoutName");
    var newName = PluginRuntime.GetRequiredString(parameters, "newName");
    var setCurrent = PluginRuntime.GetOptionalBool(parameters, "setCurrent") ?? true;

    return CivilExecution.ExecuteInCommandContextAsync<object?>(() =>
    {
      var doc = App.DocumentManager.MdiActiveDocument
        ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
      var database = doc.Database;
      using var documentLock = doc.LockDocument();

      ObjectId sourceLayoutId;
      ObjectId sourceBtrId;
      using (var tr = database.TransactionManager.StartTransaction())
      {
        var (sourceLayout, sourceLayoutIdFound, sourceBtrIdFound) = FindLayout(database, tr, sourceLayoutName);
        if (sourceLayout == null)
        {
          throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
            $"Layout '{sourceLayoutName}' was not found. Available layouts: {DescribeLayouts(database, tr)}.");
        }
        if (FindLayout(database, tr, newName).Layout != null)
        {
          throw new JsonRpcDispatchException("CIVIL3D.CONFLICT", $"A layout named '{newName}' already exists. Choose a different name or delete it first.");
        }
        sourceLayoutId = sourceLayoutIdFound;
        sourceBtrId = sourceBtrIdFound;
        tr.Commit();
      }

      var newLayoutId = LayoutManager.Current.CreateLayout(newName);

      int entitiesCopied;
      using (var tr = database.TransactionManager.StartTransaction())
      {
        var sourceLayout = CivilObjectUtils.GetRequiredObject<Layout>(tr, sourceLayoutId, OpenMode.ForRead);
        var sourceBtr = CivilObjectUtils.GetRequiredObject<BlockTableRecord>(tr, sourceBtrId, OpenMode.ForRead);
        var newLayout = CivilObjectUtils.GetRequiredObject<Layout>(tr, newLayoutId, OpenMode.ForWrite);

        try
        {
          // Page setup only (paper size, plot device/style, plot area): best-effort, never fatal.
          // The title block and border below are what actually has to survive.
          newLayout.CopyFrom(sourceLayout);
        }
        catch
        {
          // ignored: an explicit -PLOT call can always set paper size/plotter later.
        }

        var sourceIds = new ObjectIdCollection();
        foreach (ObjectId id in sourceBtr)
        {
          sourceIds.Add(id);
        }

        entitiesCopied = sourceIds.Count;
        if (sourceIds.Count > 0)
        {
          var idMap = new IdMapping();
          database.DeepCloneObjects(sourceIds, newLayout.BlockTableRecordId, idMap, false);
        }

        tr.Commit();
      }

      if (setCurrent)
      {
        LayoutManager.Current.CurrentLayout = newName;
      }

      return Task.FromResult<object?>(new Dictionary<string, object?>
      {
        ["sourceLayoutName"] = sourceLayoutName,
        ["newName"] = newName,
        ["entitiesCopied"] = entitiesCopied,
        ["created"] = true,
      });
    });
  }

  public static Task<object?> RenameLayoutAsync(JsonObject? parameters)
  {
    var oldName = PluginRuntime.GetRequiredString(parameters, "oldName");
    var newName = PluginRuntime.GetRequiredString(parameters, "newName");

    return CivilExecution.ExecuteInCommandContextAsync<object?>(() =>
    {
      var doc = App.DocumentManager.MdiActiveDocument
        ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
      using var documentLock = doc.LockDocument();

      using (var tr = doc.Database.TransactionManager.StartTransaction())
      {
        if (FindLayout(doc.Database, tr, oldName).Layout == null)
        {
          throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
            $"Layout '{oldName}' was not found. Available layouts: {DescribeLayouts(doc.Database, tr)}.");
        }
        if (FindLayout(doc.Database, tr, newName).Layout != null)
        {
          throw new JsonRpcDispatchException("CIVIL3D.CONFLICT", $"A layout named '{newName}' already exists.");
        }
        tr.Commit();
      }

      LayoutManager.Current.RenameLayout(oldName, newName);

      return Task.FromResult<object?>(new Dictionary<string, object?>
      {
        ["oldName"] = oldName,
        ["newName"] = newName,
        ["renamed"] = true,
      });
    });
  }

  public static Task<object?> DeleteLayoutAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");

    return CivilExecution.ExecuteInCommandContextAsync<object?>(() =>
    {
      var doc = App.DocumentManager.MdiActiveDocument
        ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
      using var documentLock = doc.LockDocument();

      if (name.Equals("Model", StringComparison.OrdinalIgnoreCase))
      {
        throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "The Model layout cannot be deleted.");
      }

      using (var tr = doc.Database.TransactionManager.StartTransaction())
      {
        if (FindLayout(doc.Database, tr, name).Layout == null)
        {
          throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND",
            $"Layout '{name}' was not found. Available layouts: {DescribeLayouts(doc.Database, tr)}.");
        }
        tr.Commit();
      }

      LayoutManager.Current.DeleteLayout(name);

      return Task.FromResult<object?>(new Dictionary<string, object?>
      {
        ["name"] = name,
        ["deleted"] = true,
      });
    });
  }

  private static IEnumerable<(Layout Layout, ObjectId LayoutId)> EnumerateLayouts(Database database, Transaction transaction)
  {
    var layoutDict = CivilObjectUtils.GetRequiredObject<DBDictionary>(transaction, database.LayoutDictionaryId, OpenMode.ForRead);
    foreach (DBDictionaryEntry entry in layoutDict)
    {
      yield return (CivilObjectUtils.GetRequiredObject<Layout>(transaction, entry.Value, OpenMode.ForRead), entry.Value);
    }
  }

  private static (Layout? Layout, ObjectId LayoutId, ObjectId BlockTableRecordId) FindLayout(Database database, Transaction transaction, string name)
  {
    foreach (var (layout, layoutId) in EnumerateLayouts(database, transaction))
    {
      if (layout.LayoutName.Equals(name, StringComparison.OrdinalIgnoreCase))
      {
        return (layout, layoutId, layout.BlockTableRecordId);
      }
    }

    return (null, ObjectId.Null, ObjectId.Null);
  }

  private static string DescribeLayouts(Database database, Transaction transaction)
  {
    var names = EnumerateLayouts(database, transaction).Select(entry => entry.Layout.LayoutName);
    return string.Join(", ", names);
  }
}
