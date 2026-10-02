import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FILE_DOMAIN_DEFINITION } from "../src/tools/domains/fileDomain.js";
import { GENERATED_TOOL_CATALOG_ENTRIES, MIGRATED_DOMAIN_DEFINITIONS } from "../src/tools/toolManifest.js";

/**
 * The `civil3d_file` domain reads office documents and attaches raster images.
 *
 * These tests pin three things the Node side owns:
 *   1. the domain shape the manifest and the catalog builder consume,
 *   2. the per-action input schema (including the extension allow-list), and
 *   3. that every declared plugin method is reachable, so the dispatcher
 *      parity test cannot pass by accident.
 *
 * They do NOT test the readers themselves. The C# parsers (.docx/.xlsx/.pptx/
 * .zip/.doc/.xls and the raster attach) compile on this host but cannot RUN
 * here: there is no Civil 3D and no Autodesk assembly to execute them against.
 */

const FILE_TOOL = "civil3d_file";

const ACTIONS = [
  "read_docx",
  "read_xlsx",
  "read_pptx",
  "read_zip",
  "read_doc",
  "read_xls",
  "attach_raster_image",
] as const;

const PLUGIN_METHODS = [
  "readDocx",
  "readXlsx",
  "readPptx",
  "readZip",
  "readDoc",
  "readXls",
  "attachRasterImage",
] as const;

function parseAction(action: string, args: Record<string, unknown>) {
  const definition = FILE_DOMAIN_DEFINITION.actions[action];
  expect(definition, `action '${action}' must be defined`).toBeDefined();
  return definition.inputSchema.parse({ action, ...args });
}

function actionRejects(action: string, args: Record<string, unknown>) {
  const definition = FILE_DOMAIN_DEFINITION.actions[action];
  expect(definition, `action '${action}' must be defined`).toBeDefined();
  const result = definition.inputSchema.safeParse({ action, ...args });
  expect(result.success, `action '${action}' must reject ${JSON.stringify(args)}`).toBe(false);
}

describe("civil3d_file domain shape", () => {
  it("declares the file domain with the canonical tool as its first exposure", () => {
    expect(FILE_DOMAIN_DEFINITION.domain).toBe("file");
    expect(FILE_DOMAIN_DEFINITION.exposures[0].toolName).toBe(FILE_TOOL);
    expect(FILE_DOMAIN_DEFINITION.exposures[0].supportedActions).toEqual([...ACTIONS]);
    expect(Object.keys(FILE_DOMAIN_DEFINITION.actions).sort()).toEqual([...ACTIONS].sort());
  });

  it("gives every action a schema, a capability set and a retry verdict", () => {
    for (const action of ACTIONS) {
      const definition = FILE_DOMAIN_DEFINITION.actions[action];
      expect(definition.action).toBe(action);
      expect(definition.inputSchema).toBeInstanceOf(z.ZodType);
      expect(definition.responseSchema).toBeInstanceOf(z.ZodType);
      expect(definition.capabilities.length).toBeGreaterThan(0);
      expect(typeof definition.requiresActiveDrawing).toBe("boolean");
      expect(typeof definition.safeForRetry).toBe("boolean");
      expect(typeof definition.execute).toBe("function");
    }
  });

  it("marks the six readers retryable and the raster attach not retryable", () => {
    const readers = ACTIONS.filter((action) => action !== "attach_raster_image");
    for (const action of readers) {
      expect(FILE_DOMAIN_DEFINITION.actions[action].safeForRetry, action).toBe(true);
      expect(FILE_DOMAIN_DEFINITION.actions[action].capabilities, action).not.toContain("create");
    }

    const attach = FILE_DOMAIN_DEFINITION.actions.attach_raster_image;
    expect(attach.safeForRetry).toBe(false);
    expect(attach.requiresActiveDrawing).toBe(true);
    expect(attach.capabilities).toContain("create");
  });

  it("requires an active drawing for every action, because every plugin method runs inside the host gate", () => {
    for (const action of ACTIONS) {
      expect(FILE_DOMAIN_DEFINITION.actions[action].requiresActiveDrawing, action).toBe(true);
    }
  });

  it("names exactly the plugin methods the dispatcher must arm", () => {
    const declared = ACTIONS.flatMap((action) => FILE_DOMAIN_DEFINITION.actions[action].pluginMethods ?? []);
    expect([...declared].sort()).toEqual([...PLUGIN_METHODS].sort());
  });

  it("resolves the canonical action from the raw arguments", () => {
    const resolveAction = FILE_DOMAIN_DEFINITION.exposures[0].resolveAction;
    expect(resolveAction({ action: "read_zip", path: "C:\\Docs\\set.zip" })).toEqual({
      action: "read_zip",
      args: { action: "read_zip", path: "C:\\Docs\\set.zip" },
    });
    expect(resolveAction({})).toEqual({ action: "", args: {} });
  });

  it("never exposes an action the domain does not define", () => {
    const exposure = FILE_DOMAIN_DEFINITION.exposures[0];
    for (const action of exposure.supportedActions) {
      expect(FILE_DOMAIN_DEFINITION.actions[action], action).toBeDefined();
    }
  });
});

describe("civil3d_file schema validation", () => {
  it("accepts a minimal well-formed call for every action", () => {
    expect(parseAction("read_docx", { path: "/docs/report.docx" })).toMatchObject({ path: "/docs/report.docx" });
    expect(parseAction("read_xlsx", { path: "/docs/quantities.xlsx", maxRows: 25 })).toMatchObject({ maxRows: 25 });
    expect(parseAction("read_pptx", { path: "/docs/review.pptx" })).toMatchObject({ path: "/docs/review.pptx" });
    expect(parseAction("read_zip", { path: "/docs/package.zip" })).toMatchObject({ path: "/docs/package.zip" });
    expect(parseAction("read_zip", { path: "/docs/package.zip", entry: "notes/readme.txt" })).toMatchObject({
      entry: "notes/readme.txt",
    });
    expect(parseAction("read_doc", { path: "/docs/legacy.doc" })).toMatchObject({ path: "/docs/legacy.doc" });
    expect(parseAction("read_xls", { path: "/docs/legacy.xls" })).toMatchObject({ path: "/docs/legacy.xls" });
    expect(parseAction("attach_raster_image", { path: "/docs/plat.png" })).toMatchObject({ path: "/docs/plat.png" });
  });

  it("rejects a missing or empty path", () => {
    for (const action of ACTIONS) {
      const definition = FILE_DOMAIN_DEFINITION.actions[action];
      expect(definition.inputSchema.safeParse({ action }).success, action).toBe(false);
      expect(definition.inputSchema.safeParse({ action, path: "" }).success, action).toBe(false);
    }
  });

  it("rejects a path with no extension at all", () => {
    for (const action of ACTIONS) {
      actionRejects(action, { path: "/docs/no-extension" });
    }
  });

  it("rejects a wrong extension on every reader, and never accepts another reader's file", () => {
    const wrong: Record<string, string> = {
      read_docx: "/docs/report.pdf",
      read_xlsx: "/docs/quantities.csv",
      read_pptx: "/docs/review.key",
      read_zip: "/docs/package.7z",
      read_doc: "/docs/legacy.rtf",
      read_xls: "/docs/legacy.ods",
    };

    for (const [action, path] of Object.entries(wrong)) {
      actionRejects(action, { path });
    }

    // The OOXML readers must not swallow their legacy binary twin, and the
    // legacy readers must not swallow the OOXML file. This is the pair a
    // per-action allow-list exists to separate.
    actionRejects("read_docx", { path: "/docs/legacy.doc" });
    actionRejects("read_doc", { path: "/docs/report.docx" });
    actionRejects("read_xlsx", { path: "/docs/legacy.xls" });
    actionRejects("read_xls", { path: "/docs/quantities.xlsx" });
  });

  it("accepts only the six documented raster extensions for the attach action", () => {
    const allowed = [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"];
    for (const extension of allowed) {
      expect(parseAction("attach_raster_image", { path: `/docs/plat${extension}` }).path).toBe(`/docs/plat${extension}`);
      expect(parseAction("attach_raster_image", { path: `/docs/PLAT${extension.toUpperCase()}` }).path).toBe(
        `/docs/PLAT${extension.toUpperCase()}`,
      );
    }

    const rejected = [".gif", ".pdf", ".dwg", ".svg", ".webp", ".psd", ".exe"];
    for (const extension of rejected) {
      actionRejects("attach_raster_image", { path: `/docs/plat${extension}` });
    }
  });

  it("rejects a non-positive raster width and keeps a valid insertion point", () => {
    actionRejects("attach_raster_image", { path: "/docs/plat.png", width: 0 });
    actionRejects("attach_raster_image", { path: "/docs/plat.png", width: -5 });

    const parsed = parseAction("attach_raster_image", {
      path: "/docs/plat.png",
      insertionPoint: { x: 100, y: 200 },
      width: 250,
      rotationDegrees: 30,
      layer: "X-IMAGES",
    });
    expect(parsed).toMatchObject({
      insertionPoint: { x: 100, y: 200 },
      width: 250,
      rotationDegrees: 30,
      layer: "X-IMAGES",
    });
    actionRejects("attach_raster_image", { path: "/docs/plat.png", insertionPoint: { x: 1 } });
  });

  it("bounds maxChars and maxRows so one call cannot pull an unbounded document", () => {
    actionRejects("read_docx", { path: "/docs/report.docx", maxChars: 0 });
    actionRejects("read_docx", { path: "/docs/report.docx", maxChars: -1 });
    actionRejects("read_docx", { path: "/docs/report.docx", maxChars: 200001 });
    actionRejects("read_xlsx", { path: "/docs/quantities.xlsx", maxRows: 0 });
    actionRejects("read_xlsx", { path: "/docs/quantities.xlsx", maxRows: 10001 });

    expect(parseAction("read_docx", { path: "/docs/report.docx", maxChars: 200000 })).toMatchObject({ maxChars: 200000 });
    expect(parseAction("read_xls", { path: "/docs/legacy.xls", maxRows: 10000 })).toMatchObject({ maxRows: 10000 });
  });

  it("rejects an unknown action and an action with the wrong literal", () => {
    expect(FILE_DOMAIN_DEFINITION.exposures[0].inputShape.action.safeParse("read_pdf").success).toBe(false);
    expect(FILE_DOMAIN_DEFINITION.exposures[0].inputShape.action.safeParse("read_docx").success).toBe(true);
    expect(FILE_DOMAIN_DEFINITION.actions.read_docx.inputSchema.safeParse({ action: "read_doc", path: "/docs/a.docx" }).success).toBe(false);
  });
});

describe("civil3d_file manifest registration", () => {
  it("appends the definition to the migrated domain list exactly once", () => {
    const matches = MIGRATED_DOMAIN_DEFINITIONS.filter((definition) => definition === FILE_DOMAIN_DEFINITION);
    expect(matches).toHaveLength(1);
    // Position is not the contract: later packages append after this one, so
    // assert the entry exists rather than that it is last.
    expect(MIGRATED_DOMAIN_DEFINITIONS).toContain(FILE_DOMAIN_DEFINITION);
  });

  it("registers one catalog entry exposing every action", () => {
    const entries = GENERATED_TOOL_CATALOG_ENTRIES.filter((entry) => entry.toolName === FILE_TOOL);
    expect(entries).toHaveLength(1);
    expect(entries[0].domain).toBe("file");
    expect(entries[0].operations).toEqual([...ACTIONS]);
    expect([...(entries[0].pluginMethods ?? [])].sort()).toEqual([...PLUGIN_METHODS].sort());
    expect(entries[0].requiresActiveDrawing).toBe(true);
    expect(entries[0].safeForRetry).toBe(false);
  });

  it("keeps the manifest edit to one import line and one appended entry", () => {
    const manifest = readFileSync(new URL("../src/tools/toolManifest.ts", import.meta.url), "utf8");
    const imports = manifest.match(/^import \{[^}]*\} from "\.\/domains\/fileDomain\.js";$/gm) ?? [];
    const entries = manifest.match(/^\s*FILE_DOMAIN_DEFINITION,\s*$/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });
});
