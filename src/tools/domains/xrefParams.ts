/**
 * One translation, shared by every caller that still speaks the pre-merge xref insert shape.
 *
 * Two merged pull requests each brought their own xref attach, and both bound the one plugin
 * command `attachXref`:
 *
 *   - LayerXrefCommands.AttachXrefAsync -- filePath / overlay / xrefName / x,y,z
 *   - XrefCommands.AttachXrefAsync      -- path / name / insert / insertionPoint
 *
 * Only one command name can exist, so the legacy shape is translated here and the hardened
 * implementation owns the command. That puts every xref import behind
 * FileBoundary.ResolveImportPath (CIVIL3D_IMPORT_ROOTS, .dwg only, must exist), which the legacy
 * path never checked.
 *
 * Deliberately free of MCP/zod imports so fase1Build.ts stays unit-testable with a fake `send`.
 */

/**
 * The legacy xref insert shape: the `acad_attach_xref` tool, the `civil3d_geometry` action
 * `attach_xref`, and the FASE 1 build spec.
 */
export interface LegacyXrefInsertArgs {
  filePath: string;
  /** true (the firm's default) selects a non-cascading overlay; false selects a cascading attach. */
  overlay?: boolean;
  xrefName?: string;
  layer?: string;
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
  /** Degrees, matching the hardened xref schema. */
  rotation?: number;
}

export interface HardenedXrefInsert {
  /** overlayXref for a non-cascading overlay, attachXref for a cascading attach. */
  command: "attachXref" | "overlayXref";
  parameters: {
    path: string;
    name: string | null;
    pathType: "absolute";
    insert: true;
    insertionPoint: { x: number; y: number; z: number };
    scale: number;
    rotation: number;
    layer: string | null;
  };
}

export function toHardenedXrefInsert(args: LegacyXrefInsertArgs): HardenedXrefInsert {
  const overlay = args.overlay ?? true;
  return {
    command: overlay ? "overlayXref" : "attachXref",
    parameters: {
      path: args.filePath,
      name: args.xrefName ?? null,
      pathType: "absolute",
      insert: true,
      insertionPoint: { x: args.x ?? 0, y: args.y ?? 0, z: args.z ?? 0 },
      scale: args.scale ?? 1,
      rotation: args.rotation ?? 0,
      layer: args.layer ?? null,
    },
  };
}
