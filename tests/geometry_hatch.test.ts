import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { sendCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
}));

vi.mock("../src/utils/ConnectionManager.js", () => ({
  withApplicationConnection: async <T>(
    operation: (client: { sendCommand: typeof sendCommandMock }) => Promise<T>,
  ) => await operation({ sendCommand: sendCommandMock }),
}));

import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { GEOMETRY_DOMAIN_DEFINITION } from "../src/tools/domains/geometryDomain.js";
import { GENERATED_TOOL_CATALOG_ENTRIES, findManifestAction } from "../src/tools/toolManifest.js";

// P2 / implementation plan item 18 — hatch creation. The domain could already LIST Hatch entities
// through list_shape_entities; create_hatch is the only new action.
function actionFieldNames(actionName: string): string[] {
  let schema = GEOMETRY_DOMAIN_DEFINITION.actions[actionName].inputSchema as z.ZodTypeAny;
  while (schema instanceof z.ZodEffects) schema = schema.innerType();
  return Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape).filter((key) => key !== "action");
}

describe("civil3d_geometry hatch creation (item 18)", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("adds create_hatch once and adds no second hatch action", () => {
    const canonical = GENERATED_TOOL_CATALOG_ENTRIES.find((entry) => entry.toolName === "civil3d_geometry");

    expect(canonical!.operations!.filter((operation) => operation.includes("hatch"))).toEqual(["create_hatch"]);
    expect(findManifestAction("civil3d_geometry", "create_hatch")).toBeDefined();
  });

  it("is a mutating, approval-gated, non-retryable action", () => {
    const definition = GEOMETRY_DOMAIN_DEFINITION.actions.create_hatch;

    expect(definition.pluginMethods).toEqual(["createHatch"]);
    expect(definition.capabilities).toEqual(["create"]);
    expect(definition.requiresActiveDrawing).toBe(true);
    expect(definition.safeForRetry).toBe(false);
    expect(isApprovalRequired({
      toolName: "civil3d_geometry",
      action: "create_hatch",
      capabilities: definition.capabilities,
      safeForRetry: definition.safeForRetry,
    })).toBe(true);
  });

  it("passes every hatch parameter to the plugin", async () => {
    sendCommandMock.mockResolvedValue({ handle: "3F", pattern: "ANSI31", ok: true });

    const result = await GEOMETRY_DOMAIN_DEFINITION.actions.create_hatch.execute({
      action: "create_hatch",
      loops: [
        { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        { points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], bulges: [0.5, 0, 0] },
      ],
      pattern: "ANSI31",
      scale: 1.5,
      angle: 45,
      islandStyle: "outer",
      associative: true,
      layer: "C-HATCH",
      colorIndex: 3,
      gradient: undefined,
      gradientAngle: undefined,
      gradientColors: undefined,
      shadeTint: undefined,
    });

    expect(sendCommandMock).toHaveBeenCalledWith("createHatch", {
      points: undefined,
      loops: [
        { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        { points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], bulges: [0.5, 0, 0] },
      ],
      pattern: "ANSI31",
      scale: 1.5,
      angle: 45,
      islandStyle: "outer",
      associative: true,
      layer: "C-HATCH",
      colorIndex: 3,
      gradient: undefined,
      gradientAngle: undefined,
      gradientColors: undefined,
      shadeTint: undefined,
    });
    expect(result).toMatchObject({ handle: "3F", ok: true });
  });

  it("carries a single points loop and the gradient parameters", async () => {
    sendCommandMock.mockResolvedValue({ handle: "40", isGradient: true });

    await GEOMETRY_DOMAIN_DEFINITION.actions.create_hatch.execute({
      action: "create_hatch",
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 16 }],
      gradient: "LINEAR",
      gradientAngle: 90,
      gradientColors: [[255, 0, 0], [0, 0, 255]],
    });

    expect(sendCommandMock).toHaveBeenCalledWith("createHatch", expect.objectContaining({
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 16 }],
      loops: undefined,
      gradient: "LINEAR",
      gradientAngle: 90,
      gradientColors: [[255, 0, 0], [0, 0, 255]],
    }));
  });

  it("validates the boundary, the pattern parameters and the gradient", () => {
    const schema = GEOMETRY_DOMAIN_DEFINITION.actions.create_hatch.inputSchema;
    const triangle = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

    expect(schema.safeParse({ action: "create_hatch", points: triangle }).success).toBe(true);
    expect(schema.safeParse({ action: "create_hatch", loops: [{ points: triangle }] }).success).toBe(true);
    expect(schema.safeParse({ action: "create_hatch" }).success).toBe(true); // the plugin names the missing boundary

    expect(schema.safeParse({ action: "create_hatch", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", loops: [] }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, scale: 0 }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, islandStyle: "unknown" }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, islandStyle: "outermost" }).success).toBe(true);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, colorIndex: 257 }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, colorIndex: 256 }).success).toBe(true);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, shadeTint: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, gradientColors: [[0, 0, 255]] }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, gradientColors: [[0, 0, 256], [0, 0, 255]] }).success).toBe(false);
    expect(schema.safeParse({ action: "create_hatch", points: triangle, gradientColors: [[0, 0, 0], [0, 0, 255]] }).success).toBe(true);
  });

  it("publishes a legacy acad_create_hatch exposure that carries every action field", () => {
    const exposure = GEOMETRY_DOMAIN_DEFINITION.exposures.find((item) => item.toolName === "acad_create_hatch");
    expect(exposure).toBeDefined();
    expect(exposure!.supportedActions).toEqual(["create_hatch"]);

    const exposed = Object.keys(exposure!.inputShape);
    expect(actionFieldNames("create_hatch").filter((field) => !exposed.includes(field))).toEqual([]);
  });
});
