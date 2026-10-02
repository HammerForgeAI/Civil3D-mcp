import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
}));

vi.mock("../src/utils/ConnectionManager.js", () => ({
  withApplicationConnection: async <T>(
    operation: (client: { sendCommand: typeof sendCommandMock }) => Promise<T>,
  ) => await operation({ sendCommand: sendCommandMock }),
}));

import { LEGEND_DOMAIN_DEFINITION } from "../src/tools/domains/legendDomain.js";
import { QC_DOMAIN_DEFINITION } from "../src/tools/domains/qcDomain.js";
import { GENERATED_TOOL_CATALOG_ENTRIES, MIGRATED_DOMAIN_DEFINITIONS } from "../src/tools/toolManifest.js";

describe("civil3d_legend — read and compare", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("reads a legend table through the native plugin handler", async () => {
    sendCommandMock.mockResolvedValue({
      tables: [
        {
          handle: "2A1",
          layer: "C-ANNO-LEGN",
          rowCount: 2,
          columnCount: 2,
          rows: [["SYMBOL", "DESCRIPTION"], ["GATE_VALVE_12IN", "12in gate valve"]],
        },
      ],
    });

    const result = await LEGEND_DOMAIN_DEFINITION.actions.read_legend_table.execute({
      action: "read_legend_table",
      handle: "2A1",
      limit: 50,
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith("readLegendTable", { handle: "2A1", limit: 50 });
    expect(result).toMatchObject({ tables: [{ handle: "2A1", layer: "C-ANNO-LEGN" }] });
  });

  it("accepts an omitted handle so every table in the drawing is returned", async () => {
    sendCommandMock.mockResolvedValue({ tables: [] });

    await LEGEND_DOMAIN_DEFINITION.actions.read_legend_table.execute({ action: "read_legend_table" });

    expect(sendCommandMock).toHaveBeenCalledWith("readLegendTable", { handle: undefined, limit: undefined });
  });

  it("validates the raw table response and rejects a row that is not an array of cells", () => {
    const responseSchema = LEGEND_DOMAIN_DEFINITION.actions.read_legend_table.responseSchema!;

    expect(() =>
      responseSchema.parse({
        tables: [
          { handle: "1", layer: "0", rowCount: 1, columnCount: 2, rows: [["A", null]] },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      responseSchema.parse({
        tables: [{ handle: "1", layer: "0", rowCount: 1, columnCount: 1, rows: ["A"] }],
      }),
    ).toThrow();
  });

  it("pairs legend rows with real block names and reports what is left on both sides", async () => {
    const result = await LEGEND_DOMAIN_DEFINITION.actions.build_symbol_dictionary.execute({
      action: "build_symbol_dictionary",
      legendRows: [
        ["GATE VALVE", "12in gate valve"],
        ["FIRE HYDRANT", "hydrant, 2-way"],
        ["OLD SYMBOL", "retired note"],
      ],
      blockNames: ["GATE_VALVE_12IN", "FIRE_HYDRANT", "MH-48"],
    });

    expect(result).toEqual({
      dictionary: [
        { blockName: "GATE_VALVE_12IN", meaning: "12in gate valve" },
        { blockName: "FIRE_HYDRANT", meaning: "hydrant, 2-way" },
      ],
      unmatchedBlocks: ["MH-48"],
      unmatchedLegendRows: [["OLD SYMBOL", "retired note"]],
    });
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it("consumes each legend row once, so a second block cannot reuse the first block's row", async () => {
    const result = await LEGEND_DOMAIN_DEFINITION.actions.build_symbol_dictionary.execute({
      action: "build_symbol_dictionary",
      legendRows: [
        ["VALVE", "gate valve"],
        ["HYDRANT", "hydrant"],
      ],
      blockNames: ["VALVE_A", "VALVE_B"],
    });

    expect(result).toEqual({
      dictionary: [{ blockName: "VALVE_A", meaning: "gate valve" }],
      unmatchedBlocks: ["VALVE_B"],
      unmatchedLegendRows: [["HYDRANT", "hydrant"]],
    });
  });

  it("compares a dictionary against the drawing in both directions", async () => {
    const result = await LEGEND_DOMAIN_DEFINITION.actions.compare_legend_vs_drawing.execute({
      action: "compare_legend_vs_drawing",
      dictionary: [
        { blockName: "GATE_VALVE_12IN", meaning: "12in gate valve" },
        { blockName: "AIR_RELEASE", meaning: "air release valve" },
      ],
      blockNames: ["gate_valve_12in", "MH-48"],
    });

    expect(result).toEqual({
      missingFromLegend: ["MH-48"],
      missingFromDrawing: ["AIR_RELEASE"],
    });
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it("requires legend rows and block names for the pure dictionary build", () => {
    const inputSchema = LEGEND_DOMAIN_DEFINITION.actions.build_symbol_dictionary.inputSchema;

    expect(() => inputSchema.parse({ action: "build_symbol_dictionary", legendRows: [], blockNames: [] })).not.toThrow();
    expect(() => inputSchema.parse({ action: "build_symbol_dictionary", legendRows: [] })).toThrow();
  });

  it("publishes one canonical read-only legend tool", () => {
    expect(LEGEND_DOMAIN_DEFINITION.domain).toBe("legend");
    expect(LEGEND_DOMAIN_DEFINITION.exposures).toHaveLength(1);

    const exposure = LEGEND_DOMAIN_DEFINITION.exposures[0];
    expect(exposure.toolName).toBe("civil3d_legend");
    expect(exposure.supportedActions).toEqual([
      "read_legend_table",
      "build_symbol_dictionary",
      "compare_legend_vs_drawing",
    ]);

    for (const actionName of exposure.supportedActions) {
      const action = LEGEND_DOMAIN_DEFINITION.actions[actionName];
      expect(action.capabilities).not.toContain("create");
      expect(action.capabilities).not.toContain("edit");
      expect(action.capabilities).not.toContain("delete");
      expect(action.safeForRetry).toBe(true);
    }

    expect(LEGEND_DOMAIN_DEFINITION.actions.build_symbol_dictionary.requiresActiveDrawing).toBe(false);
    expect(LEGEND_DOMAIN_DEFINITION.actions.compare_legend_vs_drawing.requiresActiveDrawing).toBe(false);
    expect(LEGEND_DOMAIN_DEFINITION.actions.read_legend_table.requiresActiveDrawing).toBe(true);
  });

  it("registers the legend domain in the manifest catalog", () => {
    expect(MIGRATED_DOMAIN_DEFINITIONS).toContain(LEGEND_DOMAIN_DEFINITION);

    const entry = GENERATED_TOOL_CATALOG_ENTRIES.find((candidate) => candidate.toolName === "civil3d_legend");
    expect(entry).toBeDefined();
    expect(entry!.domain).toBe("legend");
    expect(entry!.operations).toEqual([
      "read_legend_table",
      "build_symbol_dictionary",
      "compare_legend_vs_drawing",
    ]);
    expect(entry!.pluginMethods).toContain("readLegendTable");
    expect(entry!.safeForRetry).toBe(true);
  });
});

describe("civil3d_qc — check_legend", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("keeps the five existing checks and generate_report beside check_legend", () => {
    const supported = QC_DOMAIN_DEFINITION.exposures[0].supportedActions;

    expect(supported).toEqual([
      "check_alignment",
      "check_profile",
      "check_corridor",
      "check_pipe_network",
      "check_surface",
      "generate_report",
      "check_legend",
    ]);
    expect(Object.keys(QC_DOMAIN_DEFINITION.actions)).toEqual(supported);
  });

  it("routes check_legend through the native QC legend handler", async () => {
    sendCommandMock.mockResolvedValue({
      legendTableCount: 1,
      legendRowCount: 3,
      symbolSource: "drawing",
      symbolCount: 4,
      matchedSymbolCount: 3,
      findings: [
        {
          severity: "warning",
          type: "legend_missing_symbol",
          symbol: "MH-48",
          message: "Symbol 'MH-48' is present in the drawing but no legend row describes it.",
        },
      ],
      totalViolations: 1,
    });

    const result = await QC_DOMAIN_DEFINITION.actions.check_legend.execute({
      action: "check_legend",
      handle: "2A1",
      blockNames: ["MH-48", "GATE_VALVE_12IN"],
      limit: 100,
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith("qcCheckLegend", {
      handle: "2A1",
      blockNames: ["MH-48", "GATE_VALVE_12IN"],
      limit: 100,
    });
    expect(result).toMatchObject({ symbolCount: 4, totalViolations: 1 });
  });

  it("accepts the drawing as the symbol source when no block list is given", async () => {
    sendCommandMock.mockResolvedValue({ symbolSource: "drawing", findings: [], totalViolations: 0 });

    await QC_DOMAIN_DEFINITION.actions.check_legend.execute({ action: "check_legend" });

    expect(sendCommandMock).toHaveBeenCalledWith("qcCheckLegend", {
      handle: undefined,
      blockNames: undefined,
      limit: undefined,
    });
  });

  it("classifies check_legend as a read-only retry-safe query", () => {
    const action = QC_DOMAIN_DEFINITION.actions.check_legend;

    expect(action.capabilities).toEqual(["query", "analyze"]);
    expect(action.requiresActiveDrawing).toBe(true);
    expect(action.safeForRetry).toBe(true);
    expect(action.pluginMethods).toEqual(["qcCheckLegend"]);
  });

  it("rejects a block list that is not an array of names", () => {
    const inputSchema = QC_DOMAIN_DEFINITION.actions.check_legend.inputSchema;

    expect(() => inputSchema.parse({ action: "check_legend", blockNames: ["A", "B"] })).not.toThrow();
    expect(() => inputSchema.parse({ action: "check_legend", blockNames: "A" })).toThrow();
    expect(() => inputSchema.parse({ action: "check_legend", limit: 0 })).toThrow();
  });
});
