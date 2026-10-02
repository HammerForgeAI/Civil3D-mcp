# P12 item 20 — SAC subassembly authoring: not shipped

Status: **abandoned for this package**. No code was added for item 20. The existing
`civil3d_assembly` action `create_subassembly` is unchanged and still builds from a stock type
through `SubassemblyCollection.ImportStockSubassembly`.

## The abandon condition

The plan's abandon rule for item 20 is: *if the SAC Runtime DLLs are unavailable or do not resolve
against `net10.0-windows`, ship nothing.* Both halves are true on the build host.

## What was checked

The donor repository `Jjo37/new-acad` drives the Autodesk Subassembly Composer runtime. Its project
file, `plugin/AcBridge-v24/src/Civil3DMcpPlugin.csproj`, declares four references by absolute path:

| Reference | HintPath in the donor csproj |
| --- | --- |
| `Subassembly.WorkflowEngine` | `D:\Program Files\Autodesk\AutoCAD 2025\C3D\SACRuntime\Subassembly.WorkflowEngine.dll` |
| `Subassembly.ActivityLibrary` | `D:\Program Files\Autodesk\AutoCAD 2025\C3D\SACRuntime\Subassembly.ActivityLibrary.dll` |
| `Subassembly.API` | `D:\Program Files\Autodesk\AutoCAD 2025\C3D\SACRuntime\Subassembly.API.dll` |
| `System.IO.Packaging` | `C:\Program Files\dotnet\shared\Microsoft.WindowsDesktop.App\8.0.10\System.IO.Packaging.dll` |

The donor project also targets `net8.0-windows`, while this fork builds `net10.0-windows`.

The fork's staged reference directory is `/home/ctate/c3d-refs`. It holds exactly six files, all
Civil 3D 2027 managed assemblies:

```
AcDbMgd.dll  AecBaseMgd.dll  AeccDbMgd.dll  AeccPressurePipesMgd.dll  accoremgd.dll  acmgd.dll
```

A search for `Subassembly*.dll` under `/home/ctate/c3d-refs`, `/home/ctate/Civil3D-mcp` and
`/home/ctate/vram-live` returns nothing. `compile-plugin.sh` passes
`/p:Civil3DReferencesPath=/home/ctate/c3d-refs`, so the donor's absolute paths cannot resolve, and
there is no NuGet package that supplies these assemblies.

## The exact signatures that cannot compile

The toolchain step that needs the runtime is the packaging step in
`AssemblyCreationCommands.BuildSACSubassemblyAsync`, which calls:

```csharp
PktFileAccess.CreatePktFile(new PktStructure
{
    Guid = guid,
    XamlFile = xamlFile,
    AtcFile = atcFile,
    CfgFile = cfgFile,
    EnumDataFile = emdFile,
    PreviewDataFile = pvdFile,
    WorkingFolder = workDir,
}, pktPath);
```

`PktFileAccess` and `PktStructure` live in the unresolvable namespace
`Autodesk.SubassemblyComposer.FileAccess` (namespace import at donor line 7). Without those two
types the method cannot compile, and no substitute exists: it is the only writer of the `.pkt`
package that `ImportSACSubassembly` consumes.

## What the fork does have, and why it is not enough

The staged `AeccDbMgd.dll` **does** expose the import half of the donor's toolchain. A string probe
of the assembly finds the symbol `ImportSACSubassembly`, and the donor records the confirmed
signature as `SubassemblyCollection.ImportSACSubassembly(name, pktFilePath, location) -> ObjectId`
(parameter names `pktFilePath`, `nodeSA`, `pDbSubassembly` are present in the same metadata region).

That is the *import* of an already-authored `.pkt`, not SAC authoring. Shipping it alone would add
a way to load a file the fork cannot create, and item 20 is the authoring toolchain. The rule for
this package is explicit: where the DLLs do not resolve, ship nothing. Item 25's design note and
this record are the whole of P12's remaining scope.

## What an operator would need to reopen item 20

1. A Civil 3D installation that contains the `SACRuntime` folder, copied to the build host.
2. Those three `Subassembly.*.dll` files staged beside the six Civil 3D references, so a
   `csproj` reference can name a file that really exists.
3. A confirmation that the same references resolve for `net10.0-windows`, or a second
   `net8.0-windows` build of the plugin, because the donor targets .NET 8.
4. A live Civil 3D session to confirm the produced `.pkt` imports, since the level-1 and level-2
   gates can prove compilation only.
