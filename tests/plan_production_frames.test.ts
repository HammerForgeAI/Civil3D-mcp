import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
}));

vi.mock("../src/utils/ConnectionManager.js", () => ({
  withApplicationConnection: async <T>(
    operation: (client: { sendCommand: typeof sendCommandMock }) => Promise<T>,
  ) => await operation({ sendCommand: sendCommandMock }),
}));

import { PLAN_PRODUCTION_DOMAIN_DEFINITION } from "../src/tools/domains/planProductionDomain.js";
import { GENERATED_TOOL_CATALOG_ENTRIES } from "../src/tools/toolManifest.js";

describe("civil3d_plan_production — view frames and match lines", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("lists view frames through the native plugin handler", async () => {
    sendCommandMock.mockResolvedValue({
      viewFrames: [
        {
          name: "View Frame - (1)",
          handle: "3F2",
          layer: "C-ROAD-VIEW",
          groupHandle: "3F0",
          groupName: "VF-1",
          properties: { Name: "View Frame - (1)", Layer: "C-ROAD-VIEW", ShowLabel: true },
        },
      ],
    });

    const result = await PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.view_frame_list.execute({
      action: "view_frame_list",
      limit: 25,
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith("listViewFrames", { limit: 25 });
    expect(result).toMatchObject({ viewFrames: [{ handle: "3F2", groupName: "VF-1" }] });
  });

  it("lists match lines through the native plugin handler", async () => {
    sendCommandMock.mockResolvedValue({
      matchLines: [
        {
          name: "Match Line - (1)",
          handle: "4A1",
          layer: "C-ROAD-MATCH",
          groupHandle: null,
          groupName: null,
          properties: { Layer: "C-ROAD-MATCH", Length: 412.5 },
        },
      ],
    });

    const result = await PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.match_line_list.execute({
      action: "match_line_list",
    });

    expect(sendCommandMock).toHaveBeenCalledWith("listMatchLines", { limit: undefined });
    expect(result).toMatchObject({ matchLines: [{ handle: "4A1", groupHandle: null }] });
  });

  it("validates an empty list and an ungrouped frame", () => {
    const viewFrameSchema = PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.view_frame_list.responseSchema!;
    const matchLineSchema = PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.match_line_list.responseSchema!;

    expect(() => viewFrameSchema.parse({ viewFrames: [] })).not.toThrow();
    expect(() => matchLineSchema.parse({ matchLines: [] })).not.toThrow();
    expect(() =>
      matchLineSchema.parse({
        matchLines: [
          { name: null, handle: "A1", layer: "0", groupHandle: null, groupName: null, properties: {} },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a property dump that carries a nested object instead of a scalar", () => {
    const viewFrameSchema = PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.view_frame_list.responseSchema!;

    expect(() =>
      viewFrameSchema.parse({
        viewFrames: [
          {
            name: "View Frame - (1)",
            handle: "A1",
            layer: "0",
            groupHandle: null,
            groupName: null,
            properties: { Collection: { nested: true } },
          },
        ],
      }),
    ).toThrow();
  });

  it("exposes both listers on the canonical tool and keeps the sheet-set actions intact", () => {
    const supported = PLAN_PRODUCTION_DOMAIN_DEFINITION.exposures[0].supportedActions;

    expect(supported).toEqual([
      "sheet_set_list",
      "sheet_set_get_info",
      "sheet_set_create",
      "sheet_add",
      "sheet_get_properties",
      "sheet_set_title_block",
      "plan_profile_sheet_update_alignment",
      "sheet_view_create",
      "sheet_view_set_scale",
      "sheet_publish_pdf",
      "sheet_set_export",
      "view_frame_list",
      "match_line_list",
    ]);
    expect(Object.keys(PLAN_PRODUCTION_DOMAIN_DEFINITION.actions)).toEqual(
      expect.arrayContaining(supported),
    );
  });

  it("publishes both listers as read-only, retry-safe queries with no create path", () => {
    for (const actionName of ["view_frame_list", "match_line_list"]) {
      const action = PLAN_PRODUCTION_DOMAIN_DEFINITION.actions[actionName];

      expect(action.capabilities).toEqual(["query", "inspect"]);
      expect(action.requiresActiveDrawing).toBe(true);
      expect(action.safeForRetry).toBe(true);
      expect(action.capabilities).not.toContain("create");
      expect(action.capabilities).not.toContain("edit");
      expect(action.capabilities).not.toContain("delete");
    }

    expect(PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.view_frame_list.pluginMethods).toEqual(["listViewFrames"]);
    expect(PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.match_line_list.pluginMethods).toEqual(["listMatchLines"]);
  });

  it("registers both listers in the generated catalog", () => {
    const entry = GENERATED_TOOL_CATALOG_ENTRIES.find(
      (candidate) => candidate.toolName === "civil3d_plan_production",
    );

    expect(entry).toBeDefined();
    expect(entry!.operations).toContain("view_frame_list");
    expect(entry!.operations).toContain("match_line_list");
    expect(entry!.pluginMethods).toEqual(expect.arrayContaining(["listViewFrames", "listMatchLines"]));
  });

  it("carries a dispatcher arm for every new plugin method", () => {
    const dispatcher = readFileSync(
      new URL("../Civil3D-MCP-Plugin/CommandDispatcher.cs", import.meta.url),
      "utf8",
    );

    for (const method of ["listViewFrames", "listMatchLines", "readLegendTable", "qcCheckLegend"]) {
      expect(dispatcher).toContain(`"${method}" =>`);
    }
  });

  it("accepts the scalar mix a real property dump returns", () => {
    const domainSchema = PLAN_PRODUCTION_DOMAIN_DEFINITION.actions.view_frame_list.responseSchema!;

    expect(() =>
      domainSchema.parse({
        viewFrames: [
          {
            name: "View Frame - (1)",
            handle: "A1",
            layer: "0",
            groupHandle: "A0",
            groupName: "VF-1",
            properties: { Scale: 50, IsLocked: false, Description: null, Name: "View Frame - (1)" },
          },
        ],
      }),
    ).not.toThrow();
  });
});
