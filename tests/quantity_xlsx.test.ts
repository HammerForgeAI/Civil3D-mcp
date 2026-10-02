import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOQ_COLUMNS,
  BOQ_QUANTITY_NUMBER_FORMAT,
  BOQ_SHEET_NAME,
  buildQuantityTakeoffWorkbook,
  type QuantityXlsxRow,
} from "../src/tools/domains/quantityXlsx.js";
import { resolveExportPath, writeExportFileAtomic } from "../src/utils/exportPathBoundary.js";

const sendCommand = vi.fn();

vi.mock("../src/utils/ConnectionManager.js", () => ({
  withApplicationConnection: async (fn: (client: { sendCommand: typeof sendCommand }) => unknown) =>
    await fn({ sendCommand }),
}));

const { QUANTITY_TAKEOFF_DOMAIN_DEFINITION } = await import("../src/tools/domains/quantityTakeoffDomain.js");

const SAMPLE_ROWS: QuantityXlsxRow[] = [
  { section: "Alignments", item: "Main St", quantity: 1234.5, unit: "m", detail: "stations 0.000 to 1234.500" },
  { section: "Parcel Areas", item: "Lot 1", quantity: null, unit: null, detail: null },
];

describe("quantity takeoff BOQ workbook builder", () => {
  it("writes the BOQ worksheet and freezes its header row", () => {
    const workbook = buildQuantityTakeoffWorkbook([]);
    const sheet = workbook.getWorksheet(BOQ_SHEET_NAME);

    expect(sheet).toBeDefined();
    expect(workbook.worksheets).toHaveLength(1);
    expect(sheet!.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("honours a caller-supplied sheet name", () => {
    const workbook = buildQuantityTakeoffWorkbook([], { sheetName: "QTO 2026" });

    expect(workbook.getWorksheet("QTO 2026")).toBeDefined();
    expect(workbook.getWorksheet(BOQ_SHEET_NAME)).toBeUndefined();
  });

  it("writes the header row in row 1 and bolds it", () => {
    const sheet = buildQuantityTakeoffWorkbook([]).getWorksheet(BOQ_SHEET_NAME)!;

    expect(BOQ_COLUMNS.map((column) => sheet.getCell(1, BOQ_COLUMNS.indexOf(column) + 1).value)).toEqual([
      "Section",
      "Item",
      "Quantity",
      "Unit",
      "Detail",
    ]);
    expect(sheet.getRow(1).font?.bold).toBe(true);
  });

  it("fixes the column widths so a reviewed BOQ keeps its shape", () => {
    const sheet = buildQuantityTakeoffWorkbook([]).getWorksheet(BOQ_SHEET_NAME)!;

    BOQ_COLUMNS.forEach((column, index) => {
      expect(sheet.getColumn(index + 1).width, column.header).toBe(column.width);
    });
  });

  it("formats the quantity column for engineering values", () => {
    const sheet = buildQuantityTakeoffWorkbook([]).getWorksheet(BOQ_SHEET_NAME)!;

    expect(sheet.getColumn("quantity").numFmt).toBe(BOQ_QUANTITY_NUMBER_FORMAT);
    expect(BOQ_QUANTITY_NUMBER_FORMAT).toBe("#,##0.000");
  });

  it("places every row in the cells directly below the header", () => {
    const sheet = buildQuantityTakeoffWorkbook(SAMPLE_ROWS).getWorksheet(BOQ_SHEET_NAME)!;

    expect(sheet.getCell("A2").value).toBe("Alignments");
    expect(sheet.getCell("B2").value).toBe("Main St");
    expect(sheet.getCell("C2").value).toBe(1234.5);
    expect(sheet.getCell("D2").value).toBe("m");
    expect(sheet.getCell("E2").value).toBe("stations 0.000 to 1234.500");

    expect(sheet.getCell("A3").value).toBe("Parcel Areas");
    expect(sheet.getCell("B3").value).toBe("Lot 1");
    expect(sheet.getCell("C3").value).toBeNull();
    expect(sheet.getCell("D3").value).toBeNull();
    expect(sheet.getCell("E3").value).toBeNull();

    expect(sheet.rowCount).toBe(SAMPLE_ROWS.length + 1);
  });

  it("serializes to a workbook that loads back with the same cells", async () => {
    const bytes = await buildQuantityTakeoffWorkbook(SAMPLE_ROWS).xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(bytes);

    const sheet = reloaded.getWorksheet(BOQ_SHEET_NAME)!;
    expect(sheet.getCell("C2").value).toBe(1234.5);
    expect(sheet.getCell("E2").value).toBe("stations 0.000 to 1234.500");
    expect(sheet.getCell("C2").numFmt).toBe(BOQ_QUANTITY_NUMBER_FORMAT);
  });
});

describe("export path boundary", () => {
  let tempRoot: string;
  const env = { CIVIL3D_EXPORT_ROOTS: "" };

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qty-xlsx-"));
    env.CIVIL3D_EXPORT_ROOTS = tempRoot;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const errorCode = (operation: () => unknown): string => {
    try {
      operation();
    } catch (error) {
      return (error as { code?: string }).code ?? "no-code";
    }
    return "no-throw";
  };

  it("refuses a relative path", () => {
    expect(errorCode(() => resolveExportPath("boq.xlsx", { allowedExtensions: [".xlsx"], env }))).toBe("CIVIL3D.INVALID_INPUT");
  });

  it("refuses a path outside the configured export roots", () => {
    const outside = path.join(tempRoot, "..", "outside", "boq.xlsx");
    expect(errorCode(() => resolveExportPath(outside, { allowedExtensions: [".xlsx"], env }))).toBe("CIVIL3D.PATH_NOT_ALLOWED");
    expect(resolveExportPath(path.join(tempRoot, "boq.xlsx"), { allowedExtensions: [".xlsx"], env })).toBe(path.join(tempRoot, "boq.xlsx"));
  });

  it("refuses an extension outside the allow-list", () => {
    expect(errorCode(() => resolveExportPath(path.join(tempRoot, "boq.csv"), { allowedExtensions: [".xlsx"], env }))).toBe("CIVIL3D.FILE_TYPE_NOT_ALLOWED");
    expect(errorCode(() => resolveExportPath(path.join(tempRoot, "boq.xlsx"), { allowedExtensions: ["xlsx"], env }))).toBe("no-throw");
  });

  it("refuses to replace an existing file unless overwrite is set", () => {
    const target = path.join(tempRoot, "boq.xlsx");
    fs.writeFileSync(target, "existing");

    expect(errorCode(() => resolveExportPath(target, { allowedExtensions: [".xlsx"], env }))).toBe("CIVIL3D.CONFLICT");
    expect(resolveExportPath(target, { allowedExtensions: [".xlsx"], overwrite: true, env })).toBe(target);
  });

  it("refuses a linked directory inside the export root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qty-xlsx-outside-"));
    const link = path.join(tempRoot, "link");
    try {
      fs.symlinkSync(outside, link, "dir");
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return; // The host cannot create links, so there is nothing to prove here.
    }

    try {
      expect(errorCode(() => resolveExportPath(path.join(link, "boq.xlsx"), { allowedExtensions: [".xlsx"], env }))).toBe("CIVIL3D.PATH_NOT_ALLOWED");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes through a temporary file and leaves no temporary file behind", () => {
    const target = path.join(tempRoot, "boq.xlsx");
    writeExportFileAtomic(target, Buffer.from("first"), false);

    expect(fs.readFileSync(target, "utf8")).toBe("first");
    expect(fs.readdirSync(tempRoot)).toEqual(["boq.xlsx"]);
  });

  it("never clobbers an existing file without overwrite", () => {
    const target = path.join(tempRoot, "boq.xlsx");
    fs.writeFileSync(target, "first");

    expect(errorCode(() => writeExportFileAtomic(target, Buffer.from("second"), false))).toBe("CIVIL3D.CONFLICT");
    expect(fs.readFileSync(target, "utf8")).toBe("first");
    expect(fs.readdirSync(tempRoot)).toEqual(["boq.xlsx"]);

    writeExportFileAtomic(target, Buffer.from("second"), true);
    expect(fs.readFileSync(target, "utf8")).toBe("second");
  });
});

describe("civil3d_quantity_takeoff export_to_xlsx", () => {
  const action = QUANTITY_TAKEOFF_DOMAIN_DEFINITION.actions.export_to_xlsx;
  const schema = action.inputSchema;

  let tempRoot: string;
  let previousRoots: string | undefined;

  beforeEach(() => {
    sendCommand.mockReset();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qty-xlsx-run-"));
    previousRoots = process.env.CIVIL3D_EXPORT_ROOTS;
    process.env.CIVIL3D_EXPORT_ROOTS = tempRoot;
  });

  afterEach(() => {
    if (previousRoots === undefined) delete process.env.CIVIL3D_EXPORT_ROOTS;
    else process.env.CIVIL3D_EXPORT_ROOTS = previousRoots;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const execute = (args: Record<string, unknown>) => action.execute(args as never);

  it("keeps the CSV export's capability and classification shape", () => {
    const csv = QUANTITY_TAKEOFF_DOMAIN_DEFINITION.actions.export_to_csv;

    expect(action.capabilities).toEqual(csv.capabilities);
    expect(action.capabilities).toEqual(["export", "generate"]);
    expect(action.safeForRetry).toBe(false);
    expect(action.requiresActiveDrawing).toBe(true);
    expect(action.responseSchema).toBeDefined();
  });

  it("requires at least one section and the selectors that section needs", () => {
    expect(schema.safeParse({ action: "export_to_xlsx", outputPath: "C:/out/boq.xlsx" }).success).toBe(false);
    expect(schema.safeParse({ action: "export_to_xlsx", outputPath: "C:/out/boq.xlsx", includeSurfaceVolumes: true, baseSurface: "EG" }).success).toBe(false);
    expect(schema.safeParse({ action: "export_to_xlsx", outputPath: "C:/out/boq.xlsx", includePipeNetworks: true, pipeNetworkNames: [] }).success).toBe(false);
    expect(schema.safeParse({ action: "export_to_xlsx", outputPath: "C:/out/boq.xlsx", includePressureNetworks: true }).success).toBe(false);
    expect(schema.safeParse({ action: "export_to_xlsx", outputPath: "C:/out/boq.xlsx", includeSurfaceVolumes: true, baseSurface: "EG", comparisonSurface: "FG" }).success).toBe(true);
    expect(schema.safeParse({ action: "export_to_xlsx", outputPath: "C:/out/boq.xlsx", includeAlignmentLengths: true }).success).toBe(true);
  });

  it("rejects the output path before it reads the drawing", async () => {
    await expect(execute({ action: "export_to_xlsx", outputPath: "boq.xlsx", includeAlignmentLengths: true })).rejects.toMatchObject({ code: "CIVIL3D.INVALID_INPUT" });
    await expect(execute({ action: "export_to_xlsx", outputPath: path.join(tempRoot, "..", "outside.xlsx"), includeAlignmentLengths: true })).rejects.toMatchObject({ code: "CIVIL3D.PATH_NOT_ALLOWED" });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("assembles every requested section from the existing takeoff commands and writes the workbook", async () => {
    sendCommand.mockImplementation(async (command: string) => {
      switch (command) {
        case "qtySurfaceVolume":
          return { baseSurface: "EG", comparisonSurface: "FG", cutVolume: 120.5, fillVolume: 40.25, netVolume: 80.25, units: "m3" };
        case "qtyAlignmentLengths":
          return { alignments: [{ name: "Main St", length: 1000, startStation: 0, endStation: 1000 }], units: "m" };
        case "qtyPipeNetworkLengths":
          return { networkName: "P-1", totalLength: 250, pipeCount: 5, units: "m" };
        case "qtyPressureNetworkLengths":
          return { networkName: "W-1", totalLength: 300, pipeCount: 6, units: "m" };
        case "qtyParcelAreas":
          return { parcels: [{ name: "Lot 1", area: 500, perimeter: 90, siteName: "Site A" }], units: "m" };
        case "qtyPointCountByGroup":
          return { groups: [{ name: "Ground", count: 12 }], totalPoints: 12 };
        default:
          throw new Error(`unexpected command '${command}'`);
      }
    });

    const result = await execute({
      action: "export_to_xlsx",
      outputPath: path.join(tempRoot, "boq.xlsx"),
      overwrite: true,
      includeSurfaceVolumes: true,
      baseSurface: "EG",
      comparisonSurface: "FG",
      includeAlignmentLengths: true,
      includePipeNetworks: true,
      pipeNetworkNames: ["P-1"],
      includePressureNetworks: true,
      pressureNetworkNames: ["W-1"],
      includeParcelAreas: true,
      includePointCounts: true,
    });

    expect(sendCommand.mock.calls.map((call) => call[0])).toEqual([
      "qtySurfaceVolume",
      "qtyAlignmentLengths",
      "qtyPipeNetworkLengths",
      "qtyPressureNetworkLengths",
      "qtyParcelAreas",
      "qtyPointCountByGroup",
    ]);
    expect(sendCommand).toHaveBeenCalledWith("qtyAlignmentLengths", { names: null, startStation: null, endStation: null });

    expect(result).toEqual({
      outputPath: path.join(tempRoot, "boq.xlsx"),
      sheetName: BOQ_SHEET_NAME,
      rowsWritten: 8,
      sectionsIncluded: ["surfaceVolumes", "alignments", "pipeNetworks", "pressureNetworks", "parcelAreas", "pointCounts"],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(tempRoot, "boq.xlsx"));
    const sheet = workbook.getWorksheet(BOQ_SHEET_NAME)!;
    expect(sheet.getCell("A2").value).toBe("Surface Volumes");
    expect(sheet.getCell("C2").value).toBe(120.5);
    expect(sheet.getCell("B5").value).toBe("Main St");
    expect(sheet.getCell("D5").value).toBe("m");
    expect(sheet.getCell("B6").value).toBe("P-1");
    expect(sheet.getCell("E6").value).toBe("5 pipes");
    expect(sheet.getCell("B7").value).toBe("W-1");
    expect(sheet.getCell("B8").value).toBe("Lot 1");
    expect(sheet.getCell("C8").value).toBe(500);
    expect(sheet.getCell("B9").value).toBe("Ground");
    expect(sheet.getCell("C9").value).toBe(12);
  });

  it("fails loudly when a requested section comes back without its collection", async () => {
    sendCommand.mockResolvedValue({});
    const target = path.join(tempRoot, "boq.xlsx");

    await expect(execute({ action: "export_to_xlsx", outputPath: target, includeParcelAreas: true })).rejects.toMatchObject({
      code: "CIVIL3D.API_ERROR",
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("exposes the action on the canonical tool and on a dedicated tool", () => {
    const canonical = QUANTITY_TAKEOFF_DOMAIN_DEFINITION.exposures.find((exposure) => exposure.toolName === "civil3d_quantity_takeoff")!;
    const dedicated = QUANTITY_TAKEOFF_DOMAIN_DEFINITION.exposures.find((exposure) => exposure.toolName === "civil3d_qty_export_to_xlsx")!;

    expect(canonical.supportedActions).toContain("export_to_xlsx");
    expect(canonical.inputShape).toHaveProperty("sheetName");
    expect(dedicated).toBeDefined();
    expect(dedicated.supportedActions).toEqual(["export_to_xlsx"]);
    expect(dedicated.resolveAction({ outputPath: "C:/out/boq.xlsx" })).toEqual({
      action: "export_to_xlsx",
      args: { action: "export_to_xlsx", outputPath: "C:/out/boq.xlsx" },
    });
  });
});
