import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

// Office and archive document reading plus raster image attach.
//
// Two shapes of work live here: reading a document that is NOT a drawing
// (.docx/.xlsx/.pptx/.zip/.doc/.xls) and attaching a raster image INTO the
// drawing. The readers do not touch the drawing at all, so they stay cheap and
// retryable. Nothing here ever writes a file.
//
// The Node schemas below reject obviously wrong input early; they are NOT the
// security boundary. Every path is validated again inside the plugin by
// FileBoundary.ResolveImportPath (absolute, inside CIVIL3D_IMPORT_ROOTS, the
// per-action extension allow-list, must exist, no reparse-point traversal),
// exactly as every other import tool does.

const MAX_TEXT_PATH_LENGTH = 4096;

function documentPathSchema(description: string, ...extensions: string[]) {
  const escaped = extensions.map((extension) => extension.replace(/\./g, "\\.")).join("|");
  return z
    .string()
    .min(1)
    .max(MAX_TEXT_PATH_LENGTH)
    .regex(new RegExp(`(?:${escaped})$`, "i"), description);
}

const DocxPathSchema = documentPathSchema("path must point to a .docx file.", ".docx");
const XlsxPathSchema = documentPathSchema("path must point to a .xlsx file.", ".xlsx");
const PptxPathSchema = documentPathSchema("path must point to a .pptx file.", ".pptx");
const ZipPathSchema = documentPathSchema("path must point to a .zip file.", ".zip");
const LegacyDocPathSchema = documentPathSchema("path must point to a .doc file (Word 97-2003).", ".doc");
const LegacyXlsPathSchema = documentPathSchema("path must point to a .xls file (Excel 97-2003).", ".xls");
const RasterPathSchema = documentPathSchema(
  "path must point to a raster image (.png, .jpg, .jpeg, .tif, .tiff or .bmp).",
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".bmp",
);

const MaxCharsSchema = z.number().int().min(1).max(200000);
const MaxRowsSchema = z.number().int().min(1).max(10000);
const Point3DSchema = z.object({ x: z.number(), y: z.number(), z: z.number().optional() });

export const DocxReadArgsSchema = z.object({
  action: z.literal("read_docx"),
  path: DocxPathSchema,
  maxChars: MaxCharsSchema.optional(),
});

export const XlsxReadArgsSchema = z.object({
  action: z.literal("read_xlsx"),
  path: XlsxPathSchema,
  maxRows: MaxRowsSchema.optional(),
});

export const PptxReadArgsSchema = z.object({
  action: z.literal("read_pptx"),
  path: PptxPathSchema,
  maxChars: MaxCharsSchema.optional(),
});

export const ZipReadArgsSchema = z.object({
  action: z.literal("read_zip"),
  path: ZipPathSchema,
  entry: z.string().min(1).max(1024).optional(),
});

export const LegacyDocReadArgsSchema = z.object({
  action: z.literal("read_doc"),
  path: LegacyDocPathSchema,
  maxChars: MaxCharsSchema.optional(),
});

export const LegacyXlsReadArgsSchema = z.object({
  action: z.literal("read_xls"),
  path: LegacyXlsPathSchema,
  maxRows: MaxRowsSchema.optional(),
});

export const RasterAttachArgsSchema = z.object({
  action: z.literal("attach_raster_image"),
  path: RasterPathSchema,
  insertionPoint: Point3DSchema.optional(),
  width: z.number().positive().optional(),
  rotationDegrees: z.number().optional(),
  layer: z.string().min(1).max(255).optional(),
});

export const TextReadResponseSchema = z.object({
  path: z.string(),
  format: z.string(),
  totalChars: z.number().int(),
  truncated: z.boolean(),
  content: z.string(),
  notes: z.array(z.string()),
});

export const ZipEntrySchema = z.object({
  name: z.string(),
  size: z.number().int(),
  compressedSize: z.number().int(),
});

export const ZipListingResponseSchema = z.object({
  path: z.string(),
  mode: z.literal("listing"),
  count: z.number().int(),
  truncated: z.boolean(),
  entries: z.array(ZipEntrySchema),
  notes: z.array(z.string()),
});

export const ZipEntryResponseSchema = z.object({
  path: z.string(),
  mode: z.literal("entry"),
  entry: z.string(),
  size: z.number().int(),
  truncated: z.boolean(),
  content: z.string(),
  notes: z.array(z.string()),
});

export const ZipReadResponseSchema = z.union([ZipListingResponseSchema, ZipEntryResponseSchema]);

export const RasterAttachResponseSchema = z.object({
  path: z.string(),
  imageDef: z.string(),
  handle: z.string(),
  widthPixels: z.number(),
  heightPixels: z.number(),
  width: z.number(),
  height: z.number(),
  insertionPoint: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  rotationDegrees: z.number(),
  notes: z.array(z.string()),
}).passthrough();

const FILE_ACTIONS = [
  "read_docx",
  "read_xlsx",
  "read_pptx",
  "read_zip",
  "read_doc",
  "read_xls",
  "attach_raster_image",
] as const;

const canonicalFileInputShape = {
  action: z.enum(FILE_ACTIONS),
  path: z.string().min(1).max(MAX_TEXT_PATH_LENGTH).optional(),
  entry: z.string().min(1).max(1024).optional(),
  maxChars: MaxCharsSchema.optional(),
  maxRows: MaxRowsSchema.optional(),
  insertionPoint: Point3DSchema.optional(),
  width: z.number().positive().optional(),
  rotationDegrees: z.number().optional(),
  layer: z.string().min(1).max(255).optional(),
};

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_ROWS = 50;

export const FILE_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "file",
  actions: {
    read_docx: {
      action: "read_docx",
      inputSchema: DocxReadArgsSchema,
      responseSchema: TextReadResponseSchema,
      capabilities: ["query", "import"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["readDocx"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("readDocx", {
          path: args.path,
          maxChars: args.maxChars ?? DEFAULT_MAX_CHARS,
        }),
      ),
    },
    read_xlsx: {
      action: "read_xlsx",
      inputSchema: XlsxReadArgsSchema,
      responseSchema: TextReadResponseSchema,
      capabilities: ["query", "import"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["readXlsx"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("readXlsx", {
          path: args.path,
          maxRows: args.maxRows ?? DEFAULT_MAX_ROWS,
        }),
      ),
    },
    read_pptx: {
      action: "read_pptx",
      inputSchema: PptxReadArgsSchema,
      responseSchema: TextReadResponseSchema,
      capabilities: ["query", "import"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["readPptx"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("readPptx", {
          path: args.path,
          maxChars: args.maxChars ?? DEFAULT_MAX_CHARS,
        }),
      ),
    },
    read_zip: {
      action: "read_zip",
      inputSchema: ZipReadArgsSchema,
      responseSchema: ZipReadResponseSchema,
      capabilities: ["query", "import"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["readZip"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("readZip", {
          path: args.path,
          entry: args.entry ?? null,
        }),
      ),
    },
    read_doc: {
      action: "read_doc",
      inputSchema: LegacyDocReadArgsSchema,
      responseSchema: TextReadResponseSchema,
      capabilities: ["query", "import"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["readDoc"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("readDoc", {
          path: args.path,
          maxChars: args.maxChars ?? DEFAULT_MAX_CHARS,
        }),
      ),
    },
    read_xls: {
      action: "read_xls",
      inputSchema: LegacyXlsReadArgsSchema,
      responseSchema: TextReadResponseSchema,
      capabilities: ["query", "import"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["readXls"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("readXls", {
          path: args.path,
          maxRows: args.maxRows ?? DEFAULT_MAX_ROWS,
        }),
      ),
    },
    attach_raster_image: {
      action: "attach_raster_image",
      inputSchema: RasterAttachArgsSchema,
      responseSchema: RasterAttachResponseSchema,
      capabilities: ["create", "import"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["attachRasterImage"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("attachRasterImage", {
          path: args.path,
          insertionPoint: args.insertionPoint ?? { x: 0, y: 0, z: 0 },
          width: args.width ?? null,
          rotationDegrees: args.rotationDegrees ?? 0,
          layer: args.layer ?? null,
        }),
      ),
    },
  },
  exposures: [
    {
      toolName: "civil3d_file",
      displayName: "Civil 3D Files",
      description:
        "Reads office documents and archives, and attaches raster images into the drawing. Readers: read_docx (.docx), read_xlsx (.xlsx), read_pptx (.pptx), read_doc (Word 97-2003 .doc), read_xls (Excel 97-2003 .xls), read_zip (entry listing, or one text entry with entry=name). Reads stay in memory. Nothing is ever extracted to disk, and the plugin caps the entry count and the decompressed size. attach_raster_image places a .png/.jpg/.jpeg/.tif/.tiff/.bmp image at insertionPoint with width and rotationDegrees; the image keeps its source aspect ratio. Every path must be absolute and inside the plugin's configured import roots (FileBoundary.ResolveImportPath), with the extension that action allows. Every action requires an open drawing, and attach_raster_image requires approval.",
      inputShape: canonicalFileInputShape,
      supportedActions: [...FILE_ACTIONS],
      resolveAction: (rawArgs) => ({ action: String(rawArgs.action ?? ""), args: rawArgs }),
    },
  ],
};
