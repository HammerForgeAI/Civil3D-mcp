import { describe, expect, it } from "vitest";
import { PLAN_VISION_DOMAIN_DEFINITION, calibrateScaleFromDimension } from "../src/tools/domains/planVisionDomain.js";
import { PLAN_VISION_SERVICE_NOT_CONFIGURED } from "../src/utils/PlanVisionBridge.js";
import { MIGRATED_DOMAIN_DEFINITIONS } from "../src/tools/toolManifest.js";

/**
 * The plan_vision domain is the only one in the server that never opens a plugin connection. These
 * tests hold its domain shape, hold the pure-arithmetic action, and prove that an installed-less
 * machine still gets one explicit error rather than a crash.
 */

const NOT_CONFIGURED_INTERPRETER = "/nonexistent/plan-vision-interpreter-for-domain-test";

function action(name: string) {
  const definition = PLAN_VISION_DOMAIN_DEFINITION.actions[name];
  expect(definition, `action '${name}' should exist`).toBeDefined();
  return definition;
}

describe("civil3d_plan_vision domain shape", () => {
  it("is registered in the runtime manifest with one canonical exposure", () => {
    expect(MIGRATED_DOMAIN_DEFINITIONS).toContain(PLAN_VISION_DOMAIN_DEFINITION);
    expect(PLAN_VISION_DOMAIN_DEFINITION.domain).toBe("plan_vision");
    expect(PLAN_VISION_DOMAIN_DEFINITION.exposures).toHaveLength(1);

    const exposure = PLAN_VISION_DOMAIN_DEFINITION.exposures[0];
    expect(exposure.toolName).toBe("civil3d_plan_vision");
    expect(exposure.supportedActions).toEqual([
      "rasterize_pdf_page",
      "extract_legend_templates",
      "train_symbol_template",
      "detect_symbols_cv",
      "ocr_extract_labels",
      "calibrate_scale_from_dimension",
    ]);
  });

  it("declares every action as drawing-independent and never names a plugin method", () => {
    for (const definition of Object.values(PLAN_VISION_DOMAIN_DEFINITION.actions)) {
      expect(definition.requiresActiveDrawing).toBe(false);
      expect(definition.pluginMethods ?? []).toEqual([]);
    }
  });

  it("resolves the raw action name, and never invents one for an unknown action", () => {
    const exposure = PLAN_VISION_DOMAIN_DEFINITION.exposures[0];
    expect(exposure.resolveAction({ action: "ocr_extract_labels" }).action).toBe("ocr_extract_labels");
    // A missing action becomes the literal string "undefined", which matches no key in `actions`,
    // so nothing can be dispatched for it.
    const resolved = exposure.resolveAction({}).action;
    expect(Object.keys(PLAN_VISION_DOMAIN_DEFINITION.actions)).not.toContain(resolved);
  });

  it("accepts the documented arguments for every service-backed action", () => {
    expect(action("rasterize_pdf_page").inputSchema.parse({
      action: "rasterize_pdf_page",
      pdfPath: "sheet.pdf",
      page: 0,
      outputPath: "sheet.png",
      dpi: 300,
    })).toMatchObject({ page: 0, dpi: 300 });

    expect(action("extract_legend_templates").inputSchema.parse({
      action: "extract_legend_templates",
      legendImagePath: "legend.png",
      libraryPath: "library",
      minConfidence: 40,
    })).toMatchObject({ minConfidence: 40 });

    expect(action("train_symbol_template").inputSchema.parse({
      action: "train_symbol_template",
      imagePath: "legend.png",
      name: "TREE",
      libraryPath: "library",
      region: { x: 1, y: 2, width: 3, height: 4 },
    })).toMatchObject({ name: "TREE" });

    expect(action("detect_symbols_cv").inputSchema.parse({
      action: "detect_symbols_cv",
      imagePath: "sheet.png",
      libraryPath: "library",
      matchThreshold: 0.8,
      scales: [0.9, 1.0],
      rotations: [0, 90],
    })).toMatchObject({ matchThreshold: 0.8 });

    expect(action("ocr_extract_labels").inputSchema.parse({
      action: "ocr_extract_labels",
      imagePath: "sheet.png",
    })).toMatchObject({ imagePath: "sheet.png" });
  });

  it("validates the service response shapes rather than passing anything through", () => {
    expect(action("rasterize_pdf_page").responseSchema?.parse({
      imagePath: "sheet.png",
      width: 2400,
      height: 1600,
    })).toMatchObject({ width: 2400, height: 1600 });

    expect(action("calibrate_scale_from_dimension").responseSchema?.parse({
      pixelDistance: 500,
      realDistance: 50,
      unitsPerPixel: 0.1,
      pixelsPerUnit: 10,
    })).toMatchObject({ unitsPerPixel: 0.1 });

    expect(() => action("calibrate_scale_from_dimension").responseSchema?.parse({ pixelDistance: 500 })).toThrow();
  });
});

describe("plan-vision actions degrade when the service is not installed", () => {
  it("fails one service-backed action with the not-configured code and message", async () => {
    process.env.PLAN_VISION_PYTHON = NOT_CONFIGURED_INTERPRETER;
    try {
      const error = await action("ocr_extract_labels")
        .execute({ action: "ocr_extract_labels", imagePath: "sheet.png" } as never)
        .then(() => undefined, (reason: unknown) => reason as Error & { code?: string });

      expect(error).toBeDefined();
      expect(error!.code).toBe(PLAN_VISION_SERVICE_NOT_CONFIGURED);
      expect(error!.message).toContain("plan-vision service is not configured");
      expect(error!.message).toContain(NOT_CONFIGURED_INTERPRETER);
    } finally {
      delete process.env.PLAN_VISION_PYTHON;
    }
  });
});

describe("calibrate_scale_from_dimension", () => {
  it("turns a known distance between two pixel points into a scale", () => {
    const result = calibrateScaleFromDimension({ x: 0, y: 0 }, { x: 300, y: 400 }, 50);
    expect(result.pixelDistance).toBe(500);
    expect(result.realDistance).toBe(50);
    expect(result.unitsPerPixel).toBeCloseTo(0.1, 10);
    expect(result.pixelsPerUnit).toBeCloseTo(10, 10);
  });

  it("rejects identical points, which have no scale", () => {
    expect(() => calibrateScaleFromDimension({ x: 5, y: 5 }, { x: 5, y: 5 }, 10)).toThrow(
      "pixelPointA and pixelPointB must be different points.",
    );
  });

  it("rejects a non-positive real distance instead of returning an infinite scale", () => {
    expect(() => calibrateScaleFromDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toThrow(
      "realDistance must be greater than zero.",
    );
  });

  it("runs without Python, because it is pure arithmetic", async () => {
    const result = await action("calibrate_scale_from_dimension")
      .execute({ action: "calibrate_scale_from_dimension", pixelPointA: { x: 0, y: 0 }, pixelPointB: { x: 3, y: 4 }, realDistance: 10 } as never)
      .then((value) => value as { pixelsPerUnit: number });

    expect(result.pixelsPerUnit).toBeCloseTo(0.5, 10);
  });
});
