# Third-party notices

This repository ports logic from community Civil 3D MCP projects into the fork's own
conventions. This file records every donor: its repository, its licence, its relationship to
other donors, and the files whose logic was ported.

The ported code is **not** copied verbatim. It is adapted to this fork's helpers
(`CivilObjectUtils`, `LookupUtils`, `PluginRuntime`, `CivilExecution`, `Civil3DCompatibility`)
and to its domain/action/`pluginMethods` shape. Copyright remains with each donor.

## Licence summary

| Donor | Licence | Copyright |
| --- | --- | --- |
| DaniGhosy/civil3d-mcp | MIT | Copyright (c) 2025 lisiting01 |
| barbosaihan/civil3d-mcp | MIT | Copyright (c) 2025 lisiting01 |
| Joshua8-AI/Civil3D-mcp | MIT | Copyright (c) 2025 lisiting01 |
| nezolder/civil3d-mcp-roslyn | MIT | Copyright (c) 2025 lisiting01 |
| Peter-Ewald/Civil3D-mcp | MIT | Copyright (c) 2025 lisiting01 |
| antonhofstader/Civil3D-mcp-python-COM | MIT | Copyright (c) 2026 Fabian Anton Muñoz |
| Jjo37/new-acad | MIT | Copyright (c) 2025-2026 Jjo |
| KevinGriffin/new_civil3d-mcp | MIT | Copyright (c) 2026 Kevin Griffin |
| Venkatchavan/OpenAEC-MCP | Apache-2.0 | Apache License, Version 2.0 |

Five MIT donors — DaniGhosy, barbosaihan, Joshua8-AI, nezolder and Peter-Ewald — carry the
same `Copyright (c) 2025 lisiting01` line and are forks of one upstream project. They are
listed separately because the ported files come from four different forks.

Two audited repositories — `kmezacivil-byte/civil3d-mcp` and `Aaradhya-Dev-Tamrakar/autocad-mcp`
— carry **no licence file**. No code from either has been read into this repository.

## Ported files, by package

### P1 — `civil3d_object` (generic object reflection)

- Donor: `DaniGhosy/civil3d-mcp` (MIT).
- Ported: `plugin/Civil3dMcpPlugin/GenericObjectCommands.cs` and
  `src/tools/domains/genericDomain.ts` — the object-type enumeration, curated property
  reads, and property-set actions.
- Rewritten, not copied: every reflection call now goes through `Civil3DCompatibility`
  (`FindProperty`, `GetPropertyValue`, `GetReadableScalarProperties`, `TrySetProperty`),
  which is the single reflection boundary in this plugin.

### P2 — `civil3d_geometry` extensions (blocks, shape detection, hatch)

- Donors: `DaniGhosy/civil3d-mcp` (MIT) — `BlockCommands.cs`, `ShapeDetectionCommands.cs`;
  `Jjo37/new-acad` (MIT) — `HatchCommands.cs`.
- Ported: block-definition inventory and counting, shape pairing/grouping/signature
  classification, and hatch creation.

### P3 — BOQ export to `.xlsx`

- Donor: `DaniGhosy/civil3d-mcp` (MIT) — `src/tools/domains/quantityDomain.ts`.
- Ported: the ExcelJS workbook builder for quantity takeoff output.
- New npm dependency: `exceljs` (MIT).

### P4 — survey FBK parser and closure gates

- Donor: `KevinGriffin/new_civil3d_mcp` (MIT) — the field-book parser.
- Ported: the FBK parser only. The FBK import path needs Survey COM interop pinned to a
  Civil 3D version, which this plugin does not reference.

### P5 — style creation in `civil3d_standards`

- Donor: `KevinGriffin/new_civil3d_mcp` (MIT) — `Civil3dMcpBridge.cs`
  (`CreatePointStyle`, `CreatePointLabelStyle`, `CreateLineLabelStyle`, `SetTextStyleFont`).
- Ported: the four style creators.

### P6 — plan-production frames and the legend domain

- Donor: `DaniGhosy/civil3d-mcp` (MIT) — `SheetProductionCommands.cs` and `LegendCommands.cs`.
- Ported: the two read-only listers (view frames, match lines) and the legend reader used by
  the new `civil3d_legend` domain and by `civil3d_qc check_legend`.

### P7 — `civil3d_file` readers and raster attachment

- Donors: `Jjo37/new-acad` (MIT) — `FileFormatCommands.cs`, `LegacyOfficeReaders.cs`;
  `KevinGriffin/new_civil3d_mcp` (MIT) — the raster attach path.
- Ported: zip and OOXML readers, the OLE2/CFB and BIFF8 legacy readers, and raster image
  attachment.

### P8 — approval layer and stage telemetry

- Donors: `Venkatchavan/OpenAEC-MCP` (Apache-2.0) — the inspect-only default and audit
  resource; `Peter-Ewald/Civil3D-mcp` (MIT) — per-stage telemetry.
- Ported: the inspect-only default, the audit resource, and per-stage timing.

### P9 — preflight health and Windows packaging

- Donors: `antonhofstader/Civil3D-mcp-python-COM` (MIT) — the environment checker;
  `KevinGriffin/new_civil3d_mcp` (MIT) — the Inno Setup installer script.
- Ported: a reduced environment preflight and the packaging recipe.

### P11 — escape hatches and connection selection

- Donors: `KevinGriffin/new_civil3d_mcp` (MIT), `nezolder/civil3d-mcp-roslyn` (MIT),
  `barbosaihan/civil3d-mcp` (MIT).
- Ported: the raw-command passthrough, the Roslyn script host, and multi-instance selection.
- New NuGet dependency: `Microsoft.CodeAnalysis.CSharp.Scripting` (MIT).

### P12 — plan vision, SAC subassemblies, COM read path

- Donors: `DaniGhosy/civil3d-mcp` (MIT), `Jjo37/new-acad` (MIT),
  `antonhofstader/Civil3D-mcp-python-COM` (MIT).
- Ported: the optional Python plan-vision service, the SAC subassembly authoring path, and the
  COM read path.

## Not ported

- `kmezacivil-byte/civil3d-mcp` and `Aaradhya-Dev-Tamrakar/autocad-mcp`: no licence file.
  No code taken.
- Item 26 (bilingual UI): this fork has no user interface, so there is no string surface to
  translate.
