import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

// Legend ("simbología y leyenda") read and compare actions.
//
// This domain is read-only on purpose. The donor (DaniGhosy, MIT) also persisted a symbol
// library to local JSON files, but nothing under src/tools/domains reads or writes a
// caller-supplied path today — every file write in this fork runs inside the plugin behind
// FileBoundary.cs — so the export, import and library-training actions stay out of the port
// until a path policy exists for them.
//
//   read_legend_table         — the drawing's Table entities as raw cells (needs the plugin).
//   build_symbol_dictionary   — cross-references those rows against real block names.
//   compare_legend_vs_drawing — the QA direction: what each side has and the other lacks.
//
// There is deliberately no "which table is the legend" heuristic: read_legend_table returns
// every table (or one by handle) and the caller picks, because the real content is easier to
// judge than a guess by position or size.

const LegendTableSchema = z.object({
  handle: z.string(),
  layer: z.string(),
  rowCount: z.number().int(),
  columnCount: z.number().int(),
  rows: z.array(z.array(z.string().nullable())),
});

const SymbolDictionaryEntrySchema = z.object({
  blockName: z.string(),
  meaning: z.string(),
});

const LegendActionSchema = z.enum([
  "read_legend_table",
  "build_symbol_dictionary",
  "compare_legend_vs_drawing",
]);

const LegendTableListResponseSchema = z.object({ tables: z.array(LegendTableSchema) });

const SymbolDictionaryResponseSchema = z.object({
  dictionary: z.array(SymbolDictionaryEntrySchema),
  unmatchedBlocks: z.array(z.string()),
  unmatchedLegendRows: z.array(z.array(z.string().nullable())),
});

const LegendComparisonResponseSchema = z.object({
  missingFromLegend: z.array(z.string()),
  missingFromDrawing: z.array(z.string()),
});

const canonicalLegendInputShape = {
  action: LegendActionSchema.describe("The legend read or compare operation to perform."),
  handle: z
    .string()
    .optional()
    .describe("Handle of a specific Table entity to read (read_legend_table). Omit to return every table in the drawing."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Maximum number of model-space entries to inspect for Table entities (read_legend_table, default 200)."),
  legendRows: z
    .array(z.array(z.string().nullable()))
    .optional()
    .describe("Raw rows from read_legend_table for the chosen legend table (build_symbol_dictionary)."),
  blockNames: z
    .array(z.string())
    .optional()
    .describe("Real block names from the drawing, e.g. from acad_list_block_references (build_symbol_dictionary, compare_legend_vs_drawing)."),
  dictionary: z
    .array(SymbolDictionaryEntrySchema)
    .optional()
    .describe("A symbol -> meaning dictionary from build_symbol_dictionary (compare_legend_vs_drawing)."),
};

const ReadLegendTableArgsSchema = z.object({
  action: z.literal("read_legend_table"),
  handle: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const BuildSymbolDictionaryArgsSchema = z.object({
  action: z.literal("build_symbol_dictionary"),
  legendRows: z.array(z.array(z.string().nullable())),
  blockNames: z.array(z.string()),
});

const CompareLegendVsDrawingArgsSchema = z.object({
  action: z.literal("compare_legend_vs_drawing"),
  dictionary: z.array(SymbolDictionaryEntrySchema),
  blockNames: z.array(z.string()),
});

/** Lower-cases text and removes whitespace, underscores and hyphens, so "GATE VALVE" and "GATE_VALVE" compare equal. */
export function normalizeLegendText(text: string): string {
  return text.toLowerCase().replace(/[\s_\-]+/g, "");
}

/**
 * Pairs legend rows with real block names by normalized substring match in either direction.
 * A row and a block name are consumed once each; anything left over on either side is reported
 * instead of dropped, which is what makes the result usable as a QA pass.
 */
export function buildSymbolDictionary(legendRows: (string | null)[][], blockNames: string[]) {
  const dictionary: { blockName: string; meaning: string }[] = [];
  const matchedRows = new Set<number>();
  const matchedBlocks = new Set<string>();

  blockNames.forEach((blockName) => {
    const normalizedBlock = normalizeLegendText(blockName);

    const rowIndex = legendRows.findIndex((row, index) => {
      if (matchedRows.has(index)) return false;
      if (normalizedBlock.length === 0) return false;
      return row.some((cell) => {
        if (!cell) return false;
        const normalizedCell = normalizeLegendText(cell);
        if (normalizedCell.length === 0) return false;
        return normalizedCell.includes(normalizedBlock) || normalizedBlock.includes(normalizedCell);
      });
    });

    if (rowIndex === -1) return;

    // The meaning is the last non-empty cell of the row: the legend's text column, not the symbol column.
    const row = legendRows[rowIndex];
    const meaning = [...row].reverse().find((cell) => cell && cell.trim().length > 0) ?? "";

    dictionary.push({ blockName, meaning });
    matchedRows.add(rowIndex);
    matchedBlocks.add(blockName);
  });

  const unmatchedBlocks = blockNames.filter((name) => !matchedBlocks.has(name));
  const unmatchedLegendRows = legendRows.filter((_, index) => !matchedRows.has(index));

  return { dictionary, unmatchedBlocks, unmatchedLegendRows };
}

/** Compares a symbol dictionary against the blocks present in the drawing, in both directions. */
export function compareLegendVsDrawing(
  dictionary: { blockName: string; meaning: string }[],
  blockNames: string[],
) {
  const dictionaryNames = new Set(dictionary.map((entry) => entry.blockName.toLowerCase()));
  const drawingNames = new Set(blockNames.map((name) => name.toLowerCase()));

  return {
    missingFromLegend: blockNames.filter((name) => !dictionaryNames.has(name.toLowerCase())),
    missingFromDrawing: dictionary
      .map((entry) => entry.blockName)
      .filter((name) => !drawingNames.has(name.toLowerCase())),
  };
}

export const LEGEND_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "legend",
  actions: {
    read_legend_table: {
      action: "read_legend_table",
      inputSchema: ReadLegendTableArgsSchema,
      responseSchema: LegendTableListResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["readLegendTable"],
      execute: async (args) =>
        await withApplicationConnection(
          async (appClient) =>
            await appClient.sendCommand("readLegendTable", {
              handle: args.handle,
              limit: args.limit,
            }),
        ),
    },
    build_symbol_dictionary: {
      action: "build_symbol_dictionary",
      inputSchema: BuildSymbolDictionaryArgsSchema,
      responseSchema: SymbolDictionaryResponseSchema,
      capabilities: ["analyze"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async (args) => {
        const parsedArgs = BuildSymbolDictionaryArgsSchema.parse(args);
        return buildSymbolDictionary(parsedArgs.legendRows, parsedArgs.blockNames);
      },
    },
    compare_legend_vs_drawing: {
      action: "compare_legend_vs_drawing",
      inputSchema: CompareLegendVsDrawingArgsSchema,
      responseSchema: LegendComparisonResponseSchema,
      capabilities: ["analyze"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async (args) => {
        const parsedArgs = CompareLegendVsDrawingArgsSchema.parse(args);
        return compareLegendVsDrawing(parsedArgs.dictionary, parsedArgs.blockNames);
      },
    },
  },
  exposures: [
    {
      toolName: "civil3d_legend",
      displayName: "Civil 3D Legend",
      description:
        "Reads a drawing's own symbol -> meaning legend instead of assuming a fixed office standard, and " +
        "compares it against the symbols the drawing actually uses. Actions: read_legend_table returns the raw " +
        "cells of the drawing's Table entities — one table by handle, or every table in model space when handle " +
        "is omitted, with no guess about which one is the legend, so the caller picks from real content; " +
        "build_symbol_dictionary is pure post-processing (no active drawing required) that pairs legend rows " +
        "with real block names (e.g. from acad_list_block_references) by case-insensitive, punctuation-insensitive " +
        "substring match, reporting the blocks no row describes and the rows no block matches instead of dropping " +
        "them; compare_legend_vs_drawing is the QA direction over an existing dictionary, listing symbols missing " +
        "from the legend and legend entries missing from the drawing. For the same check against the live drawing " +
        "in one call, use civil3d_qc action=check_legend.",
      inputShape: canonicalLegendInputShape,
      supportedActions: [
        "read_legend_table",
        "build_symbol_dictionary",
        "compare_legend_vs_drawing",
      ],
      resolveAction: (rawArgs) => ({ action: String(rawArgs.action ?? ""), args: rawArgs }),
    },
  ],
};
