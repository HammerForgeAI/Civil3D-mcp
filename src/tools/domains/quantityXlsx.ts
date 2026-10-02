import ExcelJS from "exceljs";

/**
 * Pure builder for the quantity-takeoff BOQ workbook.
 *
 * The plugin writes the CSV export itself, but no plugin method writes spreadsheet bytes, so this
 * workbook is built in the MCP server process and written through `exportPathBoundary.ts`. Keeping
 * the builder pure means the sheet layout is unit-testable without a live Civil 3D session.
 */

export const BOQ_SHEET_NAME = "BOQ";

/** Column widths are fixed so a BOQ read into a review sheet keeps its shape. */
export const BOQ_COLUMNS = [
  { header: "Section", key: "section", width: 24 },
  { header: "Item", key: "item", width: 46 },
  { header: "Quantity", key: "quantity", width: 16 },
  { header: "Unit", key: "unit", width: 12 },
  { header: "Detail", key: "detail", width: 34 },
] as const;

/** Quantities are engineering values: three decimals, thousands separator. */
export const BOQ_QUANTITY_NUMBER_FORMAT = "#,##0.000";

export const BOQ_QUANTITY_COLUMN_KEY = "quantity";

export interface QuantityXlsxRow {
  /** Takeoff section that produced the row, for example "Alignments". */
  section: string;
  /** The measured object, for example an alignment or parcel name. */
  item: string;
  /** The measured value, or null when the source reported no number. */
  quantity: number | null;
  /** Unit reported by Civil 3D, or null when the source reported none. */
  unit: string | null;
  /** Short qualifying text, for example a station range or a pipe count. */
  detail: string | null;
}

export interface QuantityXlsxOptions {
  /** Worksheet name. Defaults to `BOQ`. */
  sheetName?: string;
}

/**
 * Builds the workbook. Row order is preserved: the caller appends sections in takeoff order, and
 * the first served row sits in row 2 because row 1 is the header.
 */
export function buildQuantityTakeoffWorkbook(
  rows: readonly QuantityXlsxRow[],
  options: QuantityXlsxOptions = {},
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Civil 3D MCP";

  const sheet = workbook.addWorksheet(options.sheetName ?? BOQ_SHEET_NAME);
  sheet.columns = BOQ_COLUMNS.map((column) => ({ ...column }));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of rows) {
    sheet.addRow({
      section: row.section,
      item: row.item,
      quantity: row.quantity,
      unit: row.unit,
      detail: row.detail,
    });
  }

  sheet.getColumn(BOQ_QUANTITY_COLUMN_KEY).numFmt = BOQ_QUANTITY_NUMBER_FORMAT;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: BOQ_COLUMNS.length } };

  return workbook;
}
