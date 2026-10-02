import { z } from "zod";
import { runPlanVisionCommand } from "../../utils/PlanVisionBridge.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

/**
 * Plan vision: read a PDF or a scanned plan sheet when there is no live Civil 3D drawing.
 *
 * This is the only domain in the server that never opens a plugin connection, so every action has
 * requiresActiveDrawing: false. Five actions dispatch to the OPTIONAL Python service in
 * plan-vision/ (see its README); calibrate_scale_from_dimension is pure arithmetic here and needs
 * nothing installed.
 *
 * Every result is a confidence-level detection over pixels, not the exactness civil3d_blocks gives
 * for real blocks in a drawing. It depends on scan quality and on the threshold chosen.
 */

const PixelPointSchema = z.object({ x: z.number(), y: z.number() });
const RegionSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const GenericPlanVisionResponseSchema = z.object({}).passthrough();

const CalibrateScaleResponseSchema = z.object({
  pixelDistance: z.number(),
  realDistance: z.number(),
  unitsPerPixel: z.number(),
  pixelsPerUnit: z.number(),
});

const canonicalPlanVisionInputShape = {
  action: z
    .enum([
      "rasterize_pdf_page",
      "extract_legend_templates",
      "train_symbol_template",
      "detect_symbols_cv",
      "ocr_extract_labels",
      "calibrate_scale_from_dimension",
    ])
    .describe("The scanned-plan reading operation to perform."),
  pdfPath: z.string().optional().describe("Absolute path to the source PDF (rasterize_pdf_page)."),
  page: z.number().optional().describe("Zero-based page index to rasterize (rasterize_pdf_page)."),
  outputPath: z.string().optional().describe("Absolute path to write the rasterized PNG to (rasterize_pdf_page)."),
  dpi: z.number().optional().describe("Rasterization resolution. Default 300 (rasterize_pdf_page)."),
  legendImagePath: z.string().optional().describe("Absolute path to an already cropped legend image (extract_legend_templates)."),
  libraryPath: z
    .string()
    .optional()
    .describe("Absolute path to the local template library (extract_legend_templates, train_symbol_template, detect_symbols_cv)."),
  imagePath: z.string().optional().describe("Absolute path to an image (train_symbol_template source, detect_symbols_cv, ocr_extract_labels)."),
  name: z.string().optional().describe("Symbol name to store the template under (train_symbol_template)."),
  region: RegionSchema.optional().describe("Pixel region to crop from imagePath. Omit for the whole image (train_symbol_template)."),
  matchThreshold: z.number().optional().describe("Minimum normalized-correlation confidence to count as a match. Default 0.75 (detect_symbols_cv)."),
  scales: z.array(z.number()).optional().describe("Scale factors to sweep. Default 0.85 to 1.15 in 5% steps (detect_symbols_cv)."),
  rotations: z.array(z.number()).optional().describe("Rotation angles in degrees to sweep. Default [0, 90, 180, 270] (detect_symbols_cv)."),
  minConfidence: z.number().optional().describe("Minimum OCR confidence, 0-100, to keep a result. Default 0 (extract_legend_templates, ocr_extract_labels)."),
  pixelPointA: PixelPointSchema.optional().describe("First pixel point of the known dimension (calibrate_scale_from_dimension)."),
  pixelPointB: PixelPointSchema.optional().describe("Second pixel point of the known dimension (calibrate_scale_from_dimension)."),
  realDistance: z.number().optional().describe("Real-world distance between the two pixel points, in the unit you want back (calibrate_scale_from_dimension)."),
};

/**
 * Converts a known real-world distance between two pixel points into units-per-pixel and
 * pixels-per-unit. Pure arithmetic: no Python, no computer vision, no drawing.
 */
export function calibrateScaleFromDimension(
  pixelPointA: { x: number; y: number },
  pixelPointB: { x: number; y: number },
  realDistance: number,
) {
  const pixelDistance = Math.hypot(pixelPointB.x - pixelPointA.x, pixelPointB.y - pixelPointA.y);
  if (pixelDistance === 0) {
    throw new Error("pixelPointA and pixelPointB must be different points.");
  }
  if (!(realDistance > 0)) {
    throw new Error("realDistance must be greater than zero.");
  }

  return {
    pixelDistance,
    realDistance,
    unitsPerPixel: realDistance / pixelDistance,
    pixelsPerUnit: pixelDistance / realDistance,
  };
}

const RasterizePdfPageArgsSchema = z.object({
  action: z.literal("rasterize_pdf_page"),
  pdfPath: z.string(),
  page: z.number().int().min(0),
  outputPath: z.string(),
  dpi: z.number().optional(),
});

const ExtractLegendTemplatesArgsSchema = z.object({
  action: z.literal("extract_legend_templates"),
  legendImagePath: z.string(),
  libraryPath: z.string(),
  minConfidence: z.number().optional(),
});

const TrainSymbolTemplateArgsSchema = z.object({
  action: z.literal("train_symbol_template"),
  imagePath: z.string(),
  name: z.string(),
  libraryPath: z.string(),
  region: RegionSchema.optional(),
});

const DetectSymbolsCvArgsSchema = z.object({
  action: z.literal("detect_symbols_cv"),
  imagePath: z.string(),
  libraryPath: z.string(),
  matchThreshold: z.number().optional(),
  scales: z.array(z.number()).optional(),
  rotations: z.array(z.number()).optional(),
});

const OcrExtractLabelsArgsSchema = z.object({
  action: z.literal("ocr_extract_labels"),
  imagePath: z.string(),
  minConfidence: z.number().optional(),
});

const CalibrateScaleArgsSchema = z.object({
  action: z.literal("calibrate_scale_from_dimension"),
  pixelPointA: PixelPointSchema,
  pixelPointB: PixelPointSchema,
  realDistance: z.number(),
});

export const PLAN_VISION_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "plan_vision",
  actions: {
    rasterize_pdf_page: {
      action: "rasterize_pdf_page",
      inputSchema: RasterizePdfPageArgsSchema,
      responseSchema: GenericPlanVisionResponseSchema,
      capabilities: ["import"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async (args) =>
        await runPlanVisionCommand("rasterize_pdf_page", {
          pdfPath: args.pdfPath,
          page: args.page,
          outputPath: args.outputPath,
          dpi: args.dpi,
        }),
    },
    extract_legend_templates: {
      action: "extract_legend_templates",
      inputSchema: ExtractLegendTemplatesArgsSchema,
      responseSchema: GenericPlanVisionResponseSchema,
      capabilities: ["analyze", "import"],
      requiresActiveDrawing: false,
      safeForRetry: false,
      execute: async (args) =>
        await runPlanVisionCommand(
          "extract_legend_templates",
          {
            legendImagePath: args.legendImagePath,
            libraryPath: args.libraryPath,
            minConfidence: args.minConfidence,
          },
          { requireTesseract: true },
        ),
    },
    train_symbol_template: {
      action: "train_symbol_template",
      inputSchema: TrainSymbolTemplateArgsSchema,
      responseSchema: GenericPlanVisionResponseSchema,
      capabilities: ["manage"],
      requiresActiveDrawing: false,
      safeForRetry: false,
      execute: async (args) =>
        await runPlanVisionCommand("train_symbol_template", {
          imagePath: args.imagePath,
          name: args.name,
          libraryPath: args.libraryPath,
          region: args.region,
        }),
    },
    detect_symbols_cv: {
      action: "detect_symbols_cv",
      inputSchema: DetectSymbolsCvArgsSchema,
      responseSchema: GenericPlanVisionResponseSchema,
      capabilities: ["analyze"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async (args) =>
        await runPlanVisionCommand("detect_symbols_cv", {
          imagePath: args.imagePath,
          libraryPath: args.libraryPath,
          matchThreshold: args.matchThreshold,
          scales: args.scales,
          rotations: args.rotations,
        }),
    },
    ocr_extract_labels: {
      action: "ocr_extract_labels",
      inputSchema: OcrExtractLabelsArgsSchema,
      responseSchema: GenericPlanVisionResponseSchema,
      capabilities: ["query"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async (args) =>
        await runPlanVisionCommand(
          "ocr_extract_labels",
          {
            imagePath: args.imagePath,
            minConfidence: args.minConfidence,
          },
          { requireTesseract: true },
        ),
    },
    calibrate_scale_from_dimension: {
      action: "calibrate_scale_from_dimension",
      inputSchema: CalibrateScaleArgsSchema,
      responseSchema: CalibrateScaleResponseSchema,
      capabilities: ["analyze"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async (args) =>
        calibrateScaleFromDimension(
          args.pixelPointA as { x: number; y: number },
          args.pixelPointB as { x: number; y: number },
          args.realDistance as number,
        ),
    },
  },
  exposures: [
    {
      toolName: "civil3d_plan_vision",
      displayName: "Civil 3D Plan Vision (scanned plans)",
      description:
        "Read a PDF or scanned plan sheet when there is no live Civil 3D drawing. This is the only " +
        "tool in this server that never opens a plugin connection, so every action has " +
        "requiresActiveDrawing: false. It returns confidence-level detections over pixels, not the " +
        "exactness civil3d_blocks gives for real blocks, so the result depends on scan quality. " +
        "Five actions need the OPTIONAL Python service in plan-vision/ (Python 3.10 or later plus " +
        "Tesseract, OpenCV, PyMuPDF, Pillow and NumPy, all pinned in plan-vision/requirements.txt). " +
        "When that service is not configured the call fails with one message that names the " +
        "interpreter and the fix; no other tool is affected. Actions: rasterize_pdf_page (PDF page " +
        "to PNG through PyMuPDF), extract_legend_templates (OCR an already cropped legend image once " +
        "and build a whole named symbol-template library from it; rows it cannot isolate come back " +
        "in unresolvedRows for train_symbol_template to correct), train_symbol_template (add or " +
        "replace one template by name), detect_symbols_cv (match every library template against the " +
        "full plan image across scales and rotations, default 0/90/180/270, with non-maximum " +
        "suppression per symbol; a template with no internal contrast is reported in " +
        "skippedTemplates with a reason instead of producing false full-confidence matches), " +
        "ocr_extract_labels (loose text labels outside the legend), and " +
        "calibrate_scale_from_dimension (pure arithmetic here, no Python: a known real-world " +
        "distance between two pixel points becomes units-per-pixel and pixels-per-unit). " +
        "Detections from detect_symbols_cv feed civil3d_quantity_takeoff the same way civil3d_blocks " +
        "counts do.",
      inputShape: canonicalPlanVisionInputShape,
      supportedActions: [
        "rasterize_pdf_page",
        "extract_legend_templates",
        "train_symbol_template",
        "detect_symbols_cv",
        "ocr_extract_labels",
        "calibrate_scale_from_dimension",
      ],
      resolveAction: (rawArgs) => ({
        action: String(rawArgs.action),
        args: rawArgs,
      }),
    },
  ],
};
