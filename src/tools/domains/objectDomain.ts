import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

/**
 * civil3d_object — generic introspection over ANY AutoCAD/Civil 3D object, for
 * the types no domain-specific tool covers. Ported from the donor's
 * genericDomain.ts, minus its entity-mutation actions (erase, move, copy,
 * rotate, layers), which civil3d_geometry already publishes.
 *
 * The plugin side never sweeps an object's properties. Every read is a NAMED
 * read from a curated allow-list, and surface types return one short curated set
 * with a note: the donor recorded a 120 s hang on get_properties for a
 * TinSurface, and a per-property timeout is impossible inside one document
 * transaction.
 */

const Point2DSchema = z.object({ x: z.number(), y: z.number() });
const Point3DSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** One property value as the plugin sends it: a scalar, a point, or null. */
const PropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  Point2DSchema,
  Point3DSchema,
]);

/** The value a caller may write: scalars only, never a point. */
const WritableValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const PropertyMapSchema = z.record(z.string(), PropertyValueSchema);

export const OBJECT_ACTIONS = [
  "list_types",
  "get_properties",
  "list_properties",
  "set_properties",
  "find_by_property",
] as const;

const ObjectActionSchema = z.enum(OBJECT_ACTIONS);

// ── Action input schemas ──

export const ListTypesArgsSchema = z.object({
  action: z.literal("list_types"),
  objectType: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only list objects whose CLR type — or a base type — matches this name, for example " +
        "'Alignment', 'Corridor', 'Line' or 'Curve'.",
    ),
  layer: z.string().min(1).optional().describe("Only list objects on this layer."),
  contains: z
    .string()
    .min(1)
    .optional()
    .describe("Only count and list object types whose name contains this text, case-insensitive."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum number of objects and of distinct types to return (default 200, maximum 1000)."),
});

export const GetPropertiesArgsSchema = z.object({
  action: z.literal("get_properties"),
  handle: z.string().min(1).describe("AutoCAD entity handle (hexadecimal) of the object to read."),
});

export const ListPropertiesArgsSchema = z.object({
  action: z.literal("list_properties"),
  handle: z.string().min(1).describe("AutoCAD entity handle (hexadecimal) of the object to inspect."),
});

export const SetPropertiesArgsSchema = z.object({
  action: z.literal("set_properties"),
  handle: z.string().min(1).describe("AutoCAD entity handle (hexadecimal) of the object to change."),
  properties: z
    .record(z.string(), WritableValueSchema)
    .describe(
      "Property names and values to write. Only Name, Layer, Description and StyleName are " +
        "writable, and each write must succeed on the object's own type.",
    ),
});

export const FindByPropertyArgsSchema = z.object({
  action: z.literal("find_by_property"),
  property: z
    .string()
    .min(1)
    .describe("Property name to compare, for example 'StyleName', 'Layer' or 'Name'."),
  value: z
    .string()
    .describe("Value to match. The comparison is text, case-insensitive, on the property's value."),
  objectType: z
    .string()
    .min(1)
    .optional()
    .describe(
      "CLR type name to filter by, for example 'Alignment', 'Corridor', 'Line' or 'Curve'. " +
        "Base type names match too.",
    ),
  layer: z.string().min(1).optional().describe("Only match objects on this layer."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum number of matches to return (default 200, maximum 1000)."),
});

// ── Action response schemas ──

export const ListTypesResponseSchema = z.object({
  contains: z.string().nullable(),
  objectType: z.string().nullable(),
  layer: z.string().nullable(),
  total: z.number(),
  typeCount: z.number(),
  truncated: z.boolean(),
  typesTruncated: z.boolean(),
  types: z.array(z.object({ objectType: z.string(), count: z.number() })),
  objects: z.array(
    z.object({
      handle: z.string(),
      objectType: z.string(),
      name: z.string().nullable(),
      layer: z.string().nullable(),
    }),
  ),
});

export const GetPropertiesResponseSchema = z.object({
  handle: z.string(),
  objectType: z.string(),
  layer: z.string().nullable(),
  isSurface: z.boolean(),
  curated: z.boolean(),
  checkedPropertyCount: z.number(),
  properties: PropertyMapSchema,
  note: z.string(),
});

export const ListPropertiesResponseSchema = z.object({
  handle: z.string(),
  objectType: z.string(),
  isSurface: z.boolean(),
  curated: z.boolean(),
  propertyCount: z.number(),
  properties: z.array(
    z.object({ name: z.string(), present: z.boolean(), writable: z.boolean() }),
  ),
  note: z.string(),
});

export const SetPropertiesResponseSchema = z.object({
  handle: z.string(),
  objectType: z.string(),
  applied: z.array(z.object({ name: z.string(), value: PropertyValueSchema })),
});

export const FindByPropertyResponseSchema = z.object({
  property: z.string(),
  value: z.string(),
  objectType: z.string().nullable(),
  layer: z.string().nullable(),
  scanned: z.number(),
  total: z.number(),
  truncated: z.boolean(),
  objects: z.array(
    z.object({
      handle: z.string(),
      objectType: z.string(),
      name: z.string().nullable(),
      layer: z.string().nullable(),
      propertyValue: PropertyValueSchema,
    }),
  ),
});

export const OBJECT_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "object",
  actions: {
    list_types: {
      action: "list_types",
      inputSchema: ListTypesArgsSchema,
      responseSchema: ListTypesResponseSchema,
      capabilities: ["query"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["listObjectTypes"],
      execute: async (args) =>
        await withApplicationConnection(
          async (appClient) =>
            await appClient.sendCommand("listObjectTypes", {
              contains: args.contains,
              objectType: args.objectType,
              layer: args.layer,
              limit: args.limit,
            }),
        ),
    },
    get_properties: {
      action: "get_properties",
      inputSchema: GetPropertiesArgsSchema,
      responseSchema: GetPropertiesResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["getObjectProperties"],
      execute: async (args) =>
        await withApplicationConnection(
          async (appClient) =>
            await appClient.sendCommand("getObjectProperties", { handle: args.handle }),
        ),
    },
    list_properties: {
      action: "list_properties",
      inputSchema: ListPropertiesArgsSchema,
      responseSchema: ListPropertiesResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["listObjectPropertyNames"],
      execute: async (args) =>
        await withApplicationConnection(
          async (appClient) =>
            await appClient.sendCommand("listObjectPropertyNames", { handle: args.handle }),
        ),
    },
    set_properties: {
      action: "set_properties",
      inputSchema: SetPropertiesArgsSchema,
      responseSchema: SetPropertiesResponseSchema,
      capabilities: ["edit"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["setObjectProperties"],
      execute: async (args) =>
        await withApplicationConnection(
          async (appClient) =>
            await appClient.sendCommand("setObjectProperties", {
              handle: args.handle,
              properties: args.properties,
            }),
        ),
    },
    find_by_property: {
      action: "find_by_property",
      inputSchema: FindByPropertyArgsSchema,
      responseSchema: FindByPropertyResponseSchema,
      capabilities: ["query"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["findObjectsByProperty"],
      execute: async (args) =>
        await withApplicationConnection(
          async (appClient) =>
            await appClient.sendCommand("findObjectsByProperty", {
              property: args.property,
              value: args.value,
              objectType: args.objectType,
              layer: args.layer,
              limit: args.limit,
            }),
        ),
    },
  },
  exposures: [
    {
      toolName: "civil3d_object",
      displayName: "Civil 3D Generic Object Inspector",
      description:
        "Reads and edits ANY AutoCAD/Civil 3D object through one generic surface, for the types " +
        "no domain-specific tool covers. Actions: list_types (the objects in this drawing with " +
        "their handle, name, type and layer, optionally filtered by objectType — a base type name " +
        "matches too — by layer, and by a type-name fragment; the same reply carries the count of " +
        "each object type), get_properties (the " +
        "curated property values of one object by handle, including StyleName where the type has " +
        "it), list_properties (the curated property names of one object, each marked present and " +
        "writable, without reading values), set_properties (writes Name, Layer, Description or " +
        "StyleName on one object by handle — the generic style engine, so it also restyles " +
        "labels found with find_by_property), find_by_property (finds objects whose type — or a " +
        "base type — matches objectType and whose named property equals value, optionally on one " +
        "layer). Reads are bounded by a curated allow-list per object type and never sweep the " +
        "whole property set: the donor measured a 120 s hang when get_properties swept a " +
        "TinSurface, so every surface type returns one short curated set with a note instead. " +
        "Read a surface's full detail through civil3d_surface. For an object type with no " +
        "curated entry, only core properties (Name, Handle, Layer, Description, StyleName) are " +
        "read, and list_properties names that limit in its note.",
      inputShape: {
        action: ObjectActionSchema.describe(
          "The generic object operation: list_types, get_properties, list_properties, " +
            "set_properties or find_by_property.",
        ),
        handle: z.string().min(1).optional().describe("Object handle (hexadecimal), for get_properties, list_properties and set_properties."),
        properties: z
          .record(z.string(), WritableValueSchema)
          .optional()
          .describe("Property names and values to write, for set_properties."),
        property: z.string().min(1).optional().describe("Property name to compare, for find_by_property."),
        value: z.string().optional().describe("Value to match, for find_by_property."),
        objectType: z
          .string()
          .min(1)
          .optional()
          .describe("CLR type name filter (base types match too), for find_by_property."),
        layer: z.string().min(1).optional().describe("Layer filter, for find_by_property."),
        contains: z.string().min(1).optional().describe("Type-name fragment filter, for list_types."),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum results, for list_types and find_by_property."),
      },
      supportedActions: [...OBJECT_ACTIONS],
      resolveAction: (rawArgs) => ({
        action: String(rawArgs.action ?? ""),
        args: rawArgs,
      }),
    },
  ],
};
