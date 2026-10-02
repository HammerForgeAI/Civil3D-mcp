import { describe, expect, it } from "vitest";
import { STANDARDS_DOMAIN_DEFINITION } from "../src/tools/domains/standardsDomain.js";

/**
 * P5 pins the four style-creation actions added to civil3d_standards. These are shape tests:
 * the C# cannot compile on this host, so what is checked here is that each action parses its
 * own arguments, that every action is reachable through the canonical exposure, and that each
 * one names the plugin method the dispatcher must carry.
 */

const NEW_ACTIONS = [
  "style_create_point",
  "style_create_point_label",
  "style_create_line_label",
  "style_set_text_font",
] as const;

function actionDefinition(action: (typeof NEW_ACTIONS)[number]) {
  const definition = STANDARDS_DOMAIN_DEFINITION.actions[action];
  expect(definition).toBeDefined();
  return definition;
}

function canonicalExposure() {
  const exposure = STANDARDS_DOMAIN_DEFINITION.exposures.find(
    (candidate) => candidate.toolName === "civil3d_standards",
  );
  expect(exposure).toBeDefined();
  return exposure!;
}

describe("standards style creation", () => {
  it("exposes all four creators on the canonical civil3d_standards exposure", () => {
    const exposure = canonicalExposure();
    for (const action of NEW_ACTIONS) {
      expect(exposure.supportedActions).toContain(action);
      expect(Object.keys(exposure.inputShape)).toContain(action === "style_set_text_font" ? "font" : "markerType");
    }

    // The action enum and the supported-action list must never drift apart.
    const enumValues = exposure.inputShape.action.options;
    expect(enumValues).toEqual(expect.arrayContaining([...NEW_ACTIONS]));
    expect(new Set(enumValues)).toEqual(new Set(exposure.supportedActions));
  });

  it("parses a point style with the donor's marker vocabulary only", () => {
    const schema = actionDefinition("style_create_point").inputSchema;

    expect(schema.parse({ action: "style_create_point", name: "P5-SURVEY" })).toEqual({
      action: "style_create_point",
      name: "P5-SURVEY",
    });

    expect(
      schema.parse({
        action: "style_create_point",
        name: "P5-SURVEY",
        description: "Survey control",
        markerType: "vline",
        markerSize: 3,
        useDrawingScale: false,
        rotation: 45,
      }),
    ).toMatchObject({ markerType: "vline", markerSize: 3, useDrawingScale: false, rotation: 45 });

    // The donor switch implements exactly four shapes; a fifth must not slip through to a default.
    expect(() => schema.parse({ action: "style_create_point", name: "X", markerType: "circle" })).toThrow();
    expect(() => schema.parse({ action: "style_create_point", name: "" })).toThrow();
    expect(() => schema.parse({ action: "style_create_point", name: "X", markerSize: 0 })).toThrow();
  });

  it("accepts a block marker and rejects an empty block name", () => {
    const schema = actionDefinition("style_create_point").inputSchema;

    expect(schema.parse({ action: "style_create_point", name: "X", blockName: "SURVEY-MARK" })).toMatchObject({
      blockName: "SURVEY-MARK",
    });
    expect(() => schema.parse({ action: "style_create_point", name: "X", blockName: "" })).toThrow();
  });

  it("parses the two label-style creators with a required name", () => {
    for (const action of ["style_create_point_label", "style_create_line_label"] as const) {
      const schema = actionDefinition(action).inputSchema;

      expect(schema.parse({ action, name: "P5-STA-ELEV" })).toEqual({ action, name: "P5-STA-ELEV" });
      expect(schema.parse({ action, name: "P5-STA-ELEV", description: "Station and elevation" })).toMatchObject({
        description: "Station and elevation",
      });
      expect(() => schema.parse({ action })).toThrow();
    }
  });

  it("requires both a text style name and a font file for the font change", () => {
    const schema = actionDefinition("style_set_text_font").inputSchema;

    expect(schema.parse({ action: "style_set_text_font", styleName: "Standard", font: "romans.shx" })).toEqual({
      action: "style_set_text_font",
      styleName: "Standard",
      font: "romans.shx",
    });
    expect(() => schema.parse({ action: "style_set_text_font", styleName: "Standard" })).toThrow();
    expect(() => schema.parse({ action: "style_set_text_font", styleName: "Standard", font: "" })).toThrow();
  });

  it("sends each creator to the plugin method the dispatcher carries", () => {
    expect(actionDefinition("style_create_point").pluginMethods).toEqual(["createPointStyle"]);
    expect(actionDefinition("style_create_point_label").pluginMethods).toEqual(["createPointLabelStyle"]);
    expect(actionDefinition("style_create_line_label").pluginMethods).toEqual(["createLineLabelStyle"]);
    expect(actionDefinition("style_set_text_font").pluginMethods).toEqual(["setTextStyleFont"]);
  });

  it("marks every creator as a drawing mutation that is not safe to retry", () => {
    for (const action of NEW_ACTIONS) {
      const definition = actionDefinition(action);
      expect(definition.requiresActiveDrawing).toBe(true);
      expect(definition.safeForRetry).toBe(false);
      expect(definition.capabilities.some((capability) => capability === "create" || capability === "edit")).toBe(true);
    }
  });

  it("leaves the read-only style_list and style_get behaviour untouched", () => {
    expect(actionDefinition("style_create_point").action).toBe("style_create_point");
    expect(STANDARDS_DOMAIN_DEFINITION.actions.style_list.inputSchema.parse({
      action: "style_list",
      objectType: "point",
    })).toEqual({ action: "style_list", objectType: "point" });
    expect(STANDARDS_DOMAIN_DEFINITION.actions.style_get.pluginMethods).toEqual(["getStyle"]);
    expect(STANDARDS_DOMAIN_DEFINITION.actions.style_list.pluginMethods).toEqual(["listStyles"]);
  });

  it("does not widen the pre-existing civil3d_style exposure", () => {
    const legacy = STANDARDS_DOMAIN_DEFINITION.exposures.find(
      (candidate) => candidate.toolName === "civil3d_style",
    );
    expect(legacy).toBeDefined();
    expect(legacy!.supportedActions).toEqual(["style_list", "style_get"]);
    expect(legacy!.operations).toEqual(["list", "get"]);
  });
});
