import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";
import { FbkParseArgsSchema, FBK_PARSE_RESPONSE_SCHEMA } from "./surveyFbk.js";

const GenericSurveyResponseSchema = z.object({}).passthrough();

const canonicalSurveyInputShape = {
  action: z.enum([
    "database_list",
    "figure_list",
    "figure_get",
    "observation_list",
    "fbk_parse",
  ]),
  name: z.string().optional(),
  databaseName: z.string().optional(),
  networkName: z.string().optional(),
  observationType: z.enum(["all", "angles", "distances", "directions", "gps"]).optional(),
  filePath: z.string().optional(),
};

const SurveyDatabaseListArgsSchema = z.object({
  action: z.literal("database_list"),
});

const SurveyDatabaseCreateArgsSchema = z.object({
  action: z.literal("database_create"),
  name: z.string(),
  path: z.string().optional(),
});

const SurveyFigureListArgsSchema = z.object({
  action: z.literal("figure_list"),
  databaseName: z.string().optional(),
});

const SurveyFigureGetArgsSchema = z.object({
  action: z.literal("figure_get"),
  name: z.string(),
  databaseName: z.string().optional(),
});

const SurveyObservationListArgsSchema = z.object({
  action: z.literal("observation_list"),
  databaseName: z.string(),
  networkName: z.string().optional(),
  observationType: z.enum(["all", "angles", "distances", "directions", "gps"]).optional(),
});

const SurveyNetworkAdjustArgsSchema = z.object({
  action: z.literal("network_adjust"),
  databaseName: z.string(),
  networkName: z.string(),
  method: z.enum(["least_squares", "compass", "transit", "crandall"]).optional(),
  confidenceLevel: z.number().min(50).max(99.9).optional(),
  applyAdjustment: z.boolean().optional(),
});

const SurveyFigureCreateArgsSchema = z.object({
  action: z.literal("figure_create"),
  databaseName: z.string(),
  figureName: z.string(),
  pointNumbers: z.array(z.number().int().positive()).min(2),
  figureStyle: z.string().optional(),
  closed: z.boolean().optional(),
  layer: z.string().optional(),
});

const SurveyLandXmlImportArgsSchema = z.object({
  action: z.literal("landxml_import"),
  filePath: z.string(),
  databaseName: z.string(),
  importPoints: z.boolean().optional(),
  importAlignments: z.boolean().optional(),
  importSurfaces: z.boolean().optional(),
  coordinateSystemOverride: z.string().optional(),
  duplicatePolicy: z.enum(["skip", "overwrite", "rename"]).optional(),
});

export const SURVEY_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "survey",
  actions: {
    database_list: {
      action: "database_list",
      inputSchema: SurveyDatabaseListArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["listSurveyDatabases"],
      execute: async () => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("listSurveyDatabases", {}),
      ),
    },
    database_create: {
      action: "database_create",
      inputSchema: SurveyDatabaseCreateArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["create", "manage"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["createSurveyDatabase"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("createSurveyDatabase", {
          name: args.name,
          path: args.path ?? null,
        }),
      ),
    },
    figure_list: {
      action: "figure_list",
      inputSchema: SurveyFigureListArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["listSurveyFigures"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("listSurveyFigures", {
          databaseName: args.databaseName ?? null,
        }),
      ),
    },
    figure_get: {
      action: "figure_get",
      inputSchema: SurveyFigureGetArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["getSurveyFigure"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("getSurveyFigure", {
          name: args.name,
          databaseName: args.databaseName ?? null,
        }),
      ),
    },
    observation_list: {
      action: "observation_list",
      inputSchema: SurveyObservationListArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["listSurveyObservations"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("listSurveyObservations", {
          databaseName: args.databaseName,
          networkName: args.networkName ?? null,
          observationType: args.observationType ?? "all",
        }),
      ),
    },
    fbk_parse: {
      action: "fbk_parse",
      inputSchema: FbkParseArgsSchema,
      responseSchema: FBK_PARSE_RESPONSE_SCHEMA,
      capabilities: ["query", "inspect"],
      // Parsing a file touches no drawing and no COM object; it is the donor's dry run.
      requiresActiveDrawing: false,
      safeForRetry: true,
      pluginMethods: ["parseFbk"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("parseFbk", {
          filePath: args.filePath,
        }),
      ),
    },
    network_adjust: {
      action: "network_adjust",
      inputSchema: SurveyNetworkAdjustArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["analyze", "manage"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["adjustSurveyNetwork"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("adjustSurveyNetwork", {
          databaseName: args.databaseName,
          networkName: args.networkName,
          method: args.method ?? "least_squares",
          confidenceLevel: args.confidenceLevel ?? 95,
          applyAdjustment: args.applyAdjustment ?? false,
        }),
      ),
    },
    figure_create: {
      action: "figure_create",
      inputSchema: SurveyFigureCreateArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["create"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["createSurveyFigure"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("createSurveyFigure", {
          databaseName: args.databaseName,
          figureName: args.figureName,
          pointNumbers: args.pointNumbers,
          figureStyle: args.figureStyle ?? null,
          closed: args.closed ?? false,
          layer: args.layer ?? null,
        }),
      ),
    },
    landxml_import: {
      action: "landxml_import",
      inputSchema: SurveyLandXmlImportArgsSchema,
      responseSchema: GenericSurveyResponseSchema,
      capabilities: ["create", "import", "manage"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["importSurveyLandXml"],
      execute: async (args) => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("importSurveyLandXml", {
          filePath: args.filePath,
          databaseName: args.databaseName,
          importPoints: args.importPoints ?? true,
          importAlignments: args.importAlignments ?? false,
          importSurfaces: args.importSurfaces ?? false,
          coordinateSystemOverride: args.coordinateSystemOverride ?? null,
          duplicatePolicy: args.duplicatePolicy ?? "skip",
        }),
      ),
    },
  },
  exposures: [
    {
      toolName: "civil3d_survey",
      displayName: "Civil 3D Survey",
      description: "Lists Civil 3D survey databases, figures, and observations through a single managed-API tool, and parses a field book (.fbk) file into its points, setups, observations and derived angles. Survey creation, import, and adjustment remain native Survey command workflows; the field-book IMPORT is deliberately not exposed (it needs the AutoCAD IMPORTFIELDBOOK command and Survey COM Interop this fork does not reference), only the parser.",
      inputShape: canonicalSurveyInputShape,
      supportedActions: [
        "database_list",
        "figure_list",
        "figure_get",
        "observation_list",
        "fbk_parse",
      ],
      resolveAction: (rawArgs) => ({
        action: String(rawArgs.action ?? ""),
        args: rawArgs,
      }),
    },
    {
      toolName: "civil3d_survey_database_list",
      displayName: "Civil 3D Survey Database List",
      description: "Lists Civil 3D survey databases associated with the current drawing.",
      inputShape: {},
      supportedActions: ["database_list"],
      resolveAction: () => ({ action: "database_list", args: { action: "database_list" } }),
    },
    {
      toolName: "civil3d_survey_figure_list",
      displayName: "Civil 3D Survey Figure List",
      description: "Lists survey figures in one or more Civil 3D survey databases.",
      inputShape: { databaseName: z.string().optional() },
      supportedActions: ["figure_list"],
      resolveAction: (rawArgs) => ({
        action: "figure_list",
        args: { action: "figure_list", databaseName: rawArgs.databaseName },
      }),
    },
    {
      toolName: "civil3d_survey_figure_get",
      displayName: "Civil 3D Survey Figure Get",
      description: "Gets detailed vertex data for a specific Civil 3D survey figure.",
      inputShape: { name: z.string(), databaseName: z.string().optional() },
      supportedActions: ["figure_get"],
      resolveAction: (rawArgs) => ({
        action: "figure_get",
        args: { action: "figure_get", name: rawArgs.name, databaseName: rawArgs.databaseName },
      }),
    },
    {
      toolName: "civil3d_survey_observation_list",
      displayName: "Civil 3D Survey Observation List",
      description: "Lists raw field-book observations stored in a Civil 3D survey database.",
      inputShape: {
        databaseName: z.string(),
        networkName: z.string().optional(),
        observationType: z.enum(["all", "angles", "distances", "directions", "gps"]).optional(),
      },
      supportedActions: ["observation_list"],
      resolveAction: (rawArgs) => ({
        action: "observation_list",
        args: {
          action: "observation_list",
          databaseName: rawArgs.databaseName,
          networkName: rawArgs.networkName,
          observationType: rawArgs.observationType,
        },
      }),
    },
    {
      toolName: "civil3d_survey_fbk_parse",
      displayName: "Civil 3D Survey Field Book Parse",
      description: "Parses a Civil 3D field book (.fbk) file: coordinate points (NEZ), station setups (STN), backsights (BS), azimuths (AZ), target heights (PRISM) and observations (F1/F2), with the angles converted out of their DMS-packed DDD.MMSSsss form. Read-only: it opens the file through the plugin's import boundary and touches no drawing. The IMPORT is not offered.",
      inputShape: { filePath: z.string() },
      supportedActions: ["fbk_parse"],
      resolveAction: (rawArgs) => ({
        action: "fbk_parse",
        args: { action: "fbk_parse", filePath: rawArgs.filePath },
      }),
    },
  ],
};
