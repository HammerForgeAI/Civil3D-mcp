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
import { GEOMETRY_DOMAIN_DEFINITION, classifyGeometryBySignature } from "../src/tools/domains/geometryDomain.js";
import { GENERATED_TOOL_CATALOG_ENTRIES, findManifestAction } from "../src/tools/toolManifest.js";

// P2 / implementation plan item 13 — raw shape detection. Three actions read real geometry through
// the plugin; classify_geometry_by_signature is pure TypeScript and must stay plugin-free.
const PLUGIN_ACTIONS = ["detect_parallel_line_pairs", "group_entities_by_proximity", "get_entity_extended_data"] as const;
const NEW_ACTIONS = [...PLUGIN_ACTIONS, "classify_geometry_by_signature"] as const;

function actionFieldNames(actionName: string): string[] {
  let schema = GEOMETRY_DOMAIN_DEFINITION.actions[actionName].inputSchema as z.ZodTypeAny;
  while (schema instanceof z.ZodEffects) schema = schema.innerType();
  return Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape).filter((key) => key !== "action");
}

describe("civil3d_geometry shape detection (item 13)", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("adds all four actions once on the canonical tool", () => {
    const canonical = GENERATED_TOOL_CATALOG_ENTRIES.find((entry) => entry.toolName === "civil3d_geometry");

    for (const action of NEW_ACTIONS) {
      expect(canonical!.operations!.filter((operation) => operation === action)).toHaveLength(1);
      expect(findManifestAction("civil3d_geometry", action)).toBeDefined();
    }

    // list_shape_entities stays the only shape lister; the four actions above are new.
    expect(canonical!.operations!.filter((operation) => operation.includes("shape"))).toEqual(["list_shape_entities"]);
  });

  it("routes detect_parallel_line_pairs through the donor plugin method", async () => {
    sendCommandMock.mockResolvedValue({ pairs: [{ handleA: "10", handleB: "11", distance: 0.5, layer: "W-PIPE" }] });

    const result = await GEOMETRY_DOMAIN_DEFINITION.actions.detect_parallel_line_pairs.execute({
      action: "detect_parallel_line_pairs",
      layer: "W-PIPE",
      angleToleranceDegrees: 1.5,
      maxDistance: 2,
    });

    expect(sendCommandMock).toHaveBeenCalledWith("detectParallelLinePairs", {
      layer: "W-PIPE",
      angleToleranceDegrees: 1.5,
      maxDistance: 2,
    });
    expect(result).toMatchObject({ pairs: [{ handleA: "10", handleB: "11" }] });
  });

  it("routes group_entities_by_proximity through the donor plugin method", async () => {
    sendCommandMock.mockResolvedValue({ groups: [{ handles: ["20", "21"], entityTypes: ["Line", "Circle"] }] });

    await GEOMETRY_DOMAIN_DEFINITION.actions.group_entities_by_proximity.execute({
      action: "group_entities_by_proximity",
      radius: 1.25,
    });

    expect(sendCommandMock).toHaveBeenCalledWith("groupEntitiesByProximity", { layer: undefined, radius: 1.25 });
  });

  it("routes get_entity_extended_data through the donor plugin method", async () => {
    sendCommandMock.mockResolvedValue({ handle: "2A", appName: "ACAD", applications: [] });

    await GEOMETRY_DOMAIN_DEFINITION.actions.get_entity_extended_data.execute({
      action: "get_entity_extended_data",
      handle: "2A",
      appName: "ACAD",
    });

    expect(sendCommandMock).toHaveBeenCalledWith("getEntityExtendedData", { handle: "2A", appName: "ACAD" });
  });

  it("validates the geometry-reading inputs", () => {
    const detection = GEOMETRY_DOMAIN_DEFINITION.actions.detect_parallel_line_pairs.inputSchema;
    expect(detection.safeParse({ action: "detect_parallel_line_pairs" }).success).toBe(true);
    expect(detection.safeParse({ action: "detect_parallel_line_pairs", angleToleranceDegrees: 0 }).success).toBe(false);
    expect(detection.safeParse({ action: "detect_parallel_line_pairs", maxDistance: -1 }).success).toBe(false);

    const grouping = GEOMETRY_DOMAIN_DEFINITION.actions.group_entities_by_proximity.inputSchema;
    expect(grouping.safeParse({ action: "group_entities_by_proximity", radius: 2 }).success).toBe(true);
    expect(grouping.safeParse({ action: "group_entities_by_proximity" }).success).toBe(false);
    expect(grouping.safeParse({ action: "group_entities_by_proximity", radius: 0 }).success).toBe(false);

    const xdata = GEOMETRY_DOMAIN_DEFINITION.actions.get_entity_extended_data.inputSchema;
    expect(xdata.safeParse({ action: "get_entity_extended_data", handle: "2A" }).success).toBe(true);
    expect(xdata.safeParse({ action: "get_entity_extended_data" }).success).toBe(false);
  });

  it("keeps classify_geometry_by_signature TypeScript-only and drawing-free", () => {
    const definition = GEOMETRY_DOMAIN_DEFINITION.actions.classify_geometry_by_signature;

    expect(definition.pluginMethods).toBeUndefined();
    expect(definition.requiresActiveDrawing).toBe(false);
    expect(definition.capabilities).toEqual(["analyze"]);
    expect(isApprovalRequired({
      toolName: "civil3d_geometry",
      action: "classify_geometry_by_signature",
      capabilities: definition.capabilities,
      safeForRetry: definition.safeForRetry,
    })).toBe(false);
  });

  it("classifies a group without opening a plugin connection", async () => {
    const result = await GEOMETRY_DOMAIN_DEFINITION.actions.classify_geometry_by_signature.execute({
      action: "classify_geometry_by_signature",
      entityTypes: ["Line", "Circle", "Arc"],
      signatures: [
        { name: "valve", entityTypes: ["Line", "Circle"] },
        { name: "manhole", entityTypes: ["Circle"] },
      ],
    });

    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ bestMatch: { name: "valve", confidence: 2 / 3 } });
  });

  it("scores signatures by Jaccard similarity and ranks them by confidence", () => {
    const result = classifyGeometryBySignature(
      ["Line", "Circle", "Arc"],
      [
        { name: "manhole", entityTypes: ["Circle"] },
        { name: "valve", entityTypes: ["Line", "Circle", "Arc"] },
        { name: "unrelated", entityTypes: ["Spline", "Ellipse"] },
      ],
    );

    expect(result.matches.map((match) => match.name)).toEqual(["valve", "manhole", "unrelated"]);
    expect(result.matches[0].confidence).toBe(1);
    expect(result.matches[1].confidence).toBe(1 / 3);
    expect(result.matches[2].confidence).toBe(0);
    expect(result.bestMatch).toEqual({ name: "valve", description: undefined, confidence: 1 });
  });

  it("matches case-insensitively, carries the description, and reports no best match on no overlap", () => {
    const result = classifyGeometryBySignature(
      ["line", "CIRCLE"],
      [
        { name: "valve", entityTypes: ["Line", "Circle"], description: "gate valve symbol" },
        { name: "spline part", entityTypes: ["Spline"] },
      ],
    );

    expect(result.matches[0]).toEqual({ name: "valve", description: "gate valve symbol", confidence: 1 });
    expect(result.bestMatch?.name).toBe("valve");

    const noOverlap = classifyGeometryBySignature(["Hatch"], [{ name: "valve", entityTypes: ["Line", "Circle"] }]);
    expect(noOverlap.matches).toEqual([{ name: "valve", description: undefined, confidence: 0 }]);
    expect(noOverlap.bestMatch).toBeNull();
  });

  it("publishes legacy single-action exposures that carry every action field", () => {
    const legacy: Array<[string, string]> = [
      ["acad_detect_parallel_line_pairs", "detect_parallel_line_pairs"],
      ["acad_group_entities_by_proximity", "group_entities_by_proximity"],
      ["acad_get_entity_extended_data", "get_entity_extended_data"],
      ["civil3d_classify_geometry_by_signature", "classify_geometry_by_signature"],
    ];

    for (const [toolName, action] of legacy) {
      const exposure = GEOMETRY_DOMAIN_DEFINITION.exposures.find((item) => item.toolName === toolName);
      expect(exposure, `${toolName} is exposed`).toBeDefined();
      expect(exposure!.supportedActions).toEqual([action]);
      const exposed = Object.keys(exposure!.inputShape);
      expect(actionFieldNames(action).filter((field) => !exposed.includes(field))).toEqual([]);
    }
  });

  it("advertises the shape entity types as free strings on the canonical tool but constrains the listers", () => {
    const canonical = GEOMETRY_DOMAIN_DEFINITION.exposures.find((entry) => entry.toolName === "civil3d_geometry")!;
    const canonicalEntityTypes = canonical.inputShape.entityTypes as z.ZodTypeAny;
    expect(canonicalEntityTypes.safeParse(["Region", "Polyline3d"]).success).toBe(true);

    // The lister's own action schema still refuses an unknown entity type.
    const lister = GEOMETRY_DOMAIN_DEFINITION.actions.list_shape_entities.inputSchema;
    expect(lister.safeParse({ action: "list_shape_entities", entityTypes: ["Region"] }).success).toBe(false);
  });
});
