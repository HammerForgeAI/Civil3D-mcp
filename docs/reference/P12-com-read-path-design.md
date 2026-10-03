# P12 item 25 — a COM read path across Civil 3D 2023–2026: design note

Status: **design note only. Nothing executable ships for item 25.**

The plan's abandon rule is: *without another Civil 3D version to verify against, document it and
ship nothing executable.* This fork rebuilds the plugin per Civil 3D version and has never
referenced the Survey or generic COM layer. One version is available. There is no second version to
test, so no COM code is added here.

## Why the fork cannot compile a COM path today

The fork speaks one protocol only: the TypeScript server sends JSON-RPC over a short-lived TCP
connection to the plugin, and the plugin calls the managed Civil 3D API inside an AutoCAD command
context. Every plugin reference is a file path staged under `C_References`; the project has zero
`PackageReference` entries.

A COM read path is a second transport with its own version pin. The donor
`antonhofstader/Civil3D-mcp-python-COM` reaches Civil 3D from Python through `pywin32`, and it
already carries that pin in code.

## What the donor does, in its own terms

The donor's `civil3d_mcp/client.py` attaches in two steps:

1. `win32com.client.GetActiveObject("AutoCAD.Application")` for the AutoCAD base object.
2. `acad.GetInterfaceObject(prog_id)` for the Civil 3D layer, trying these ProgIDs in order:

| ProgID | Donor's comment |
| --- | --- |
| `AeccXUiLand.AeccApplication.14.4` | Civil 3D 2026 |
| `AeccXUiLand.AeccApplication.13.7` | Civil 3D 2025 |
| `AeccXUiLand.AeccApplication.14.0` | Civil 3D 2024 |
| `AeccXUiLand.AeccApplication.13.0` | Civil 3D 2023 |

The donor notes that the `GetInterfaceObject` promotion is needed because Civil 3D 2025 does not
always register its `AeccApplication` in the Running Object Table. It falls back to the plain
AutoCAD document, where Civil 3D collections are unavailable.

The donor also searches absolute `C:\Program Files\Autodesk\AutoCAD 20xx` roots for `AeccDbMgd.dll`,
`AeccLandMgd.dll` and `acdbmgd.dll`, and states that `AeccLandMgd.dll` is present in 2023 and 2024
and removed in 2025 and later. That statement is itself a version claim this fork cannot check with
one version installed.

## What a COM read path in this fork would have to decide

| Decision | Why it cannot be settled here |
| --- | --- |
| Which ProgID set to try | The set above is the donor's claim. Only 2026 is present, so the 2023, 2024 and 2025 ProgIDs are untested. |
| Whether `AeccLandMgd.dll` is required for a Survey read | The donor says the assembly disappears after 2024. A reader built for 2023/2024 must not be the same binary as one built for 2025/2026. |
| Whether the COM layer is inside the plugin or beside it | The donor is a Python process with `pywin32`. This fork's plugin is C#; using COM from it adds an interop assembly per version. |
| Whether a read is safe in the approval flow | A COM read of a live drawing is a second concurrent door into the same document. The plugin's single-threaded `CivilExecution` rule exists to prevent exactly that. |

## The check the operator must run before this can be built

Run the donor's own probe on each supported version in turn, with that version open and a drawing
loaded, and record which ProgID answers:

```python
import win32com.client as w32
acad = w32.GetActiveObject("AutoCAD.Application")
for prog_id in [
    "AeccXUiLand.AeccApplication.14.4",
    "AeccXUiLand.AeccApplication.13.7",
    "AeccXUiLand.AeccApplication.14.0",
    "AeccXUiLand.AeccApplication.13.0",
]:
    try:
        civil = acad.GetInterfaceObject(prog_id)
        print(prog_id, "OK", civil is not None)
    except Exception as exc:
        print(prog_id, "FAIL", exc)
```

A version that answers lets a read path be written and compiled against it. A version that does not
answer needs its own ProgID, which must come from that installation, not from a guess.

## Recommendation

Keep item 25 documented, as the plan says. Build it only when a second Civil 3D version is available
to verify against, and treat one Python probe per version, recorded in this file, as the entry
condition. Until then the fork has no COM path, and that is the correct state.
