/**
 * Fase 1 build: assembles a "C-300 water & sewer plan, existing conditions only" sheet from a
 * pre-computed spec (see the civil3d-mcp-workflows skill, scripts/c300-build-spec.mjs and
 * references/c300-water-sewer-plan.md section 7 "Pipeline automatizado") in ONE MCP tool call
 * instead of the ~20 individual calls the section describes -- same idea as fase1Audit.ts (which
 * turned 8 reads into 1 call), applied to the write side.
 *
 * This orchestrates existing plugin RPC methods only (newDrawing, saveDrawing, attachXref,
 * createAlignment, insertBlockReference, createEntities, setViewportTwist, listTextEntities,
 * updateTextContent) -- no new C# code needed. What it deliberately does NOT do: read X-TOPO,
 * query the Property Appraiser, transcribe as-builts, or decide what the entities should be --
 * that stays in c300-build-spec.mjs / pa-lookup.mjs / poc-extract.mjs (external data, not Civil 3D
 * mutations). This tool takes their OUTPUT (a spec) and draws it.
 *
 * Kept free of MCP/zod imports so it can be unit-tested with a fake `send`, same as fase1Audit.ts.
 */
export type Fase1BuildStatus = "OK" | "FAIL" | "SKIPPED";

export interface Fase1BuildStep {
  name: string;
  status: Fase1BuildStatus;
  detail: string;
}

export interface Fase1BuildXref {
  filePath: string;
  layer?: string;
  overlay?: boolean;
  xrefName?: string;
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
  rotation?: number;
}

export interface Fase1BuildAlignment {
  name: string;
  points: { x: number; y: number }[];
  type?: "centerline" | "offset";
  site?: string;
  style?: string;
  layer?: string;
  labelSet?: string;
}

export interface Fase1BuildTwist {
  layout: string;
  viewportHandle?: string;
  twistDegrees?: number;
  streetAngleDegrees?: number;
  centerX?: number;
  centerY?: number;
}

export interface Fase1BuildClImport {
  blockName: string;
  sourceFilePath: string;
}

export interface Fase1BuildTitleReplacement {
  layout: string;
  /** Substring used to find the ONE text entity to edit (e.g. a fragment only that field has). */
  contains: string;
  find: string;
  replace: string;
}

export type Fase1BuildEntity = Record<string, unknown> & { kind: string };

export interface Fase1BuildOptions {
  templatePath?: string;
  saveAs?: string;
  overwrite?: boolean;
  xrefs?: Fase1BuildXref[];
  alignment?: Fase1BuildAlignment;
  clImport?: Fase1BuildClImport;
  entities?: Fase1BuildEntity[];
  layers?: Record<string, unknown>;
  entitySpace?: "model" | "paper";
  entityLayout?: string;
  twists?: Fase1BuildTwist[];
  titleBlock?: Fase1BuildTitleReplacement[];
  /** Final civil3d_drawing save. Default true. Set false to review before saving yourself. */
  save?: boolean;
}

export type PluginSend = (method: string, params: Record<string, unknown>) => Promise<unknown>;

type Loose = Record<string, unknown>;

export async function runFase1Build(send: PluginSend, options: Fase1BuildOptions): Promise<Fase1BuildStep[]> {
  const steps: Fase1BuildStep[] = [];
  let aborted = false;
  const add = (name: string, status: Fase1BuildStatus, detail = "") => steps.push({ name, status, detail });

  const call = async (name: string, method: string, params: Loose): Promise<Loose | undefined> => {
    if (aborted) {
      add(name, "SKIPPED", "an earlier step failed");
      return undefined;
    }
    try {
      const value = (await send(method, params)) as Loose | undefined;
      add(name, "OK", summarize(value));
      return value;
    } catch (error) {
      aborted = true;
      add(name, "FAIL", error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  // 1-2: open the template and give it a real path (mirrors the recipe's steps 5-6: civil3d_drawing
  // new templatePath=... -> save saveAs=... overwrite:true -- there is no "open a file" RPC).
  if (options.templatePath) {
    await call("open template", "newDrawing", { templatePath: options.templatePath });
  }
  if (options.saveAs) {
    await call("save as", "saveDrawing", { saveAs: options.saveAs, overwrite: options.overwrite ?? false });
  }

  // 3: xrefs (step 7 -- Overlay, the firm's hard rule; default true here too)
  for (const xref of options.xrefs ?? []) {
    await call(`xref ${basename(xref.filePath)}`, "attachXref", {
      filePath: xref.filePath,
      overlay: xref.overlay ?? true,
      xrefName: xref.xrefName,
      layer: xref.layer,
      x: xref.x,
      y: xref.y,
      z: xref.z,
      scale: xref.scale,
      rotation: xref.rotation,
    });
  }

  // 4: alignment (step 8 -- pass style/labelSet up front so a separate set_style call isn't needed)
  if (options.alignment) {
    await call(`alignment ${options.alignment.name}`, "createAlignment", {
      name: options.alignment.name,
      points: options.alignment.points,
      type: options.alignment.type,
      site: options.alignment.site,
      style: options.alignment.style,
      layer: options.alignment.layer,
      labelSet: options.alignment.labelSet,
    });
  }

  // 5: import the block DEFINITION for the first matching block entity (step 9 -- e.g. "_cl" from
  // X-TOPO), then let the batch below place any further copies (create_entities needs the block to
  // already be defined in the drawing; it has no sourceFilePath of its own).
  let entities = options.entities ?? [];
  if (options.clImport) {
    const idx = entities.findIndex((e) => e.kind === "block" && e.blockName === options.clImport!.blockName);
    const label = `import block "${options.clImport.blockName}"`;
    if (idx >= 0) {
      const first = entities[idx];
      await call(label, "insertBlockReference", {
        blockName: options.clImport.blockName,
        sourceFilePath: options.clImport.sourceFilePath,
        x: first.x,
        y: first.y,
        z: first.z,
        rotation: first.rotation,
        scaleX: first.scale ?? first.scaleX,
        scaleY: first.scale ?? first.scaleY,
        scaleZ: first.scale ?? first.scaleZ,
        layer: first.layer,
      });
      entities = [...entities.slice(0, idx), ...entities.slice(idx + 1)];
    } else {
      add(label, "SKIPPED", "no block entity with that blockName in the batch");
    }
  }

  // 6: everything else in one batch (step 10)
  if (entities.length) {
    await call(`create ${entities.length} entities`, "createEntities", {
      entities,
      layers: options.layers,
      space: options.entitySpace,
      layout: options.entityLayout,
    });
  }

  // 7: viewport + Model-tab twist (steps 11 and 11b -- pass both in `twists`)
  for (const twist of options.twists ?? []) {
    await call(`twist ${twist.layout}`, "setViewportTwist", {
      layout: twist.layout,
      viewportHandle: twist.viewportHandle,
      twistDegrees: twist.twistDegrees,
      streetAngleDegrees: twist.streetAngleDegrees,
      centerX: twist.centerX,
      centerY: twist.centerY,
    });
  }

  // 8: title block substring replacements (step 12 -- find the one text containing a known
  // fragment, replace only the changed substring, preserving every other MText code untouched).
  for (const tb of options.titleBlock ?? []) {
    const name = `title block: "${tb.find}" -> "${tb.replace}"`;
    if (aborted) {
      add(name, "SKIPPED", "an earlier step failed");
      continue;
    }
    try {
      const found = (await send("listTextEntities", { space: "paper", layout: tb.layout, contains: tb.contains, limit: 20 })) as
        | { entities?: { handle: string; text: string }[] }
        | undefined;
      const entity = found?.entities?.[0];
      if (!entity) {
        aborted = true;
        add(name, "FAIL", `no text containing "${tb.contains}" found on layout "${tb.layout}"`);
        continue;
      }
      if (!entity.text.includes(tb.find)) {
        aborted = true;
        add(name, "FAIL", `handle ${entity.handle} (matched by "${tb.contains}") does not contain "${tb.find}" -- read it and pass the exact substring`);
        continue;
      }
      const newText = entity.text.split(tb.find).join(tb.replace);
      await send("updateTextContent", { handle: entity.handle, text: newText });
      add(name, "OK", `handle ${entity.handle}`);
    } catch (error) {
      aborted = true;
      add(name, "FAIL", error instanceof Error ? error.message : String(error));
    }
  }

  // 9: save (step 13)
  if (options.save !== false) {
    await call("save", "saveDrawing", { overwrite: true });
  }

  return steps;
}

export function summarizeFase1Build(steps: Fase1BuildStep[]): { fail: number; skipped: number; ok: number; summary: string } {
  const fail = steps.filter((s) => s.status === "FAIL").length;
  const skipped = steps.filter((s) => s.status === "SKIPPED").length;
  const ok = steps.filter((s) => s.status === "OK").length;
  return {
    fail,
    skipped,
    ok,
    summary: fail
      ? `Fase 1 build: stopped after ${ok} step(s) OK, 1 FAIL (${skipped} step(s) skipped after it)`
      : `Fase 1 build: ${ok} step(s) OK`,
  };
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function summarize(value: Loose | undefined): string {
  if (value == null) return "";
  if (typeof value.handle === "string") return `handle ${value.handle}`;
  if (typeof value.name === "string") return String(value.name);
  if (typeof value.createdCount === "number") return `${value.createdCount} created`;
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
