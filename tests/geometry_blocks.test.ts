import { readFileSync } from "node:fs";
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

// P2 / implementation plan item 12 — block intelligence. The domain already had
// list/insert/update_block_reference, so exactly two actions are added and no block action repeats.
const NEW_ACTIONS = ["list_block_definitions", "count_blocks_by_name"] as const;

function actionFieldNames(actionName: string): string[] {
  let schema = GEOMETRY_DOMAIN_DEFINITION.actions[actionName].inputSchema as z.ZodTypeAny;
  while (schema instanceof z.ZodEffects) schema = schema.innerType();
  return Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape).filter((key) => key !== "action");
}

describe("civil3d_geometry block intelligence (item 12)", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("adds the two missing block actions exactly once on the canonical tool", () => {
    const canonical = GENERATED_TOOL_CATALOG_ENTRIES.find((entry) => entry.toolName === "civil3d_geometry");
    expect(canonical).toBeDefined();

    for (const action of NEW_ACTIONS) {
      expect(canonical!.operations!.filter((operation) => operation === action)).toHaveLength(1);
      expect(findManifestAction("civil3d_geometry", action)).toBeDefined();
    }

    // The three pre-existing block actions are untouched and no fourth block-reference action appears.
    const blockOperations = canonical!.operations!.filter((operation) => operation.includes("block"));
    expect(blockOperations).toEqual([
      "list_block_references",
      "update_block_reference",
      "insert_block_reference",
      "list_block_definitions",
      "count_blocks_by_name",
    ]);
  });

  it("declares the donor plugin methods and read-only traits", () => {
    expect(GEOMETRY_DOMAIN_DEFINITION.actions.list_block_definitions.pluginMethods).toEqual(["listBlockDefinitions"]);
    expect(GEOMETRY_DOMAIN_DEFINITION.actions.count_blocks_by_name.pluginMethods).toEqual(["countBlocksByName"]);

    for (const action of NEW_ACTIONS) {
      const definition = GEOMETRY_DOMAIN_DEFINITION.actions[action];
      expect(definition.capabilities).toEqual(["query"]);
      expect(definition.requiresActiveDrawing).toBe(true);
      expect(definition.safeForRetry).toBe(true);
      expect(isApprovalRequired({
        toolName: "civil3d_geometry",
        action,
        capabilities: definition.capabilities,
        safeForRetry: definition.safeForRetry,
      })).toBe(false);
    }
  });

  it("calls listBlockDefinitions with no parameters", async () => {
    sendCommandMock.mockResolvedValue({ blocks: [{ name: "TOMACORRIENTE", insertionCount: 3, isDynamicBlock: false }] });

    const result = await GEOMETRY_DOMAIN_DEFINITION.actions.list_block_definitions.execute({ action: "list_block_definitions" });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith("listBlockDefinitions", {});
    expect(result).toMatchObject({ blocks: [{ name: "TOMACORRIENTE", insertionCount: 3 }] });
  });

  it("calls countBlocksByName with the name and the optional layout", async () => {
    sendCommandMock.mockResolvedValue({ name: "TOMACORRIENTE", layout: "PLAN", count: 7 });

    const result = await GEOMETRY_DOMAIN_DEFINITION.actions.count_blocks_by_name.execute({
      action: "count_blocks_by_name",
      name: "TOMACORRIENTE",
      layout: "PLAN",
    });

    expect(sendCommandMock).toHaveBeenCalledWith("countBlocksByName", { name: "TOMACORRIENTE", layout: "PLAN" });
    expect(result).toMatchObject({ count: 7 });

    await GEOMETRY_DOMAIN_DEFINITION.actions.count_blocks_by_name.execute({ action: "count_blocks_by_name", name: "TEE" });
    expect(sendCommandMock).toHaveBeenLastCalledWith("countBlocksByName", { name: "TEE", layout: undefined });
  });

  it("requires a non-empty block name and permits an optional layout", () => {
    const schema = GEOMETRY_DOMAIN_DEFINITION.actions.count_blocks_by_name.inputSchema;

    expect(schema.safeParse({ action: "count_blocks_by_name", name: "TEE" }).success).toBe(true);
    expect(schema.safeParse({ action: "count_blocks_by_name", name: "TEE", layout: "C-100" }).success).toBe(true);
    expect(schema.safeParse({ action: "count_blocks_by_name" }).success).toBe(false);
    expect(schema.safeParse({ action: "count_blocks_by_name", name: "" }).success).toBe(false);
    expect(schema.safeParse({ action: "list_block_definitions", name: "TEE" }).success).toBe(false);
  });

  it("publishes legacy single-action exposures that carry every action field", () => {
    const legacy: Array<[string, string]> = [
      ["acad_list_block_definitions", "list_block_definitions"],
      ["acad_count_blocks_by_name", "count_blocks_by_name"],
    ];

    for (const [toolName, action] of legacy) {
      const exposure = GEOMETRY_DOMAIN_DEFINITION.exposures.find((item) => item.toolName === toolName);
      expect(exposure, `${toolName} is exposed`).toBeDefined();
      expect(exposure!.supportedActions).toEqual([action]);
      const exposed = Object.keys(exposure!.inputShape);
      expect(actionFieldNames(action).filter((field) => !exposed.includes(field))).toEqual([]);
    }
  });

  it("has a dispatcher arm for every new plugin method", () => {
    const dispatcher = readFileSync(new URL("../Civil3D-MCP-Plugin/CommandDispatcher.cs", import.meta.url), "utf8");
    const dispatched = new Set([...dispatcher.matchAll(/^\s*"([^"]+)"\s*=>/gm)].map((match) => match[1]));

    for (const action of NEW_ACTIONS) {
      for (const method of GEOMETRY_DOMAIN_DEFINITION.actions[action].pluginMethods ?? []) {
        expect(dispatched.has(method), `${method} is dispatched`).toBe(true);
      }
    }
  });
});
