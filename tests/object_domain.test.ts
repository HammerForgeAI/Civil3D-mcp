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

import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { buildExposureAnnotations } from "../src/tools/domainRuntime.js";
import {
  FindByPropertyArgsSchema,
  FindByPropertyResponseSchema,
  GetPropertiesArgsSchema,
  GetPropertiesResponseSchema,
  ListPropertiesArgsSchema,
  ListPropertiesResponseSchema,
  ListTypesArgsSchema,
  ListTypesResponseSchema,
  OBJECT_ACTIONS,
  OBJECT_DOMAIN_DEFINITION,
  SetPropertiesArgsSchema,
  SetPropertiesResponseSchema,
} from "../src/tools/domains/objectDomain.js";
import { GENERATED_TOOL_CATALOG_ENTRIES, findManifestAction } from "../src/tools/toolManifest.js";

const pluginSource = (fileName: string) =>
  readFileSync(new URL(`../Civil3D-MCP-Plugin/${fileName}`, import.meta.url), "utf8");

/** The same markers tests/reflection_boundary.test.ts fails on, applied to one file. */
const directReflectionPattern =
  /System\.Reflection|BindingFlags|\bType\.GetType|\.GetType\(\)\.Get(?:Property|Properties|Method|Methods|Field|Fields)|typeof\([^)]*\)\.Get(?:Method|Methods|Property)|AppDomain\.CurrentDomain\.GetAssemblies/;

const pluginMethodToCommandMethod: Record<string, string> = {
  listObjectTypes: "ListObjectTypesAsync",
  getObjectProperties: "GetObjectPropertiesAsync",
  listObjectPropertyNames: "ListObjectPropertyNamesAsync",
  setObjectProperties: "SetObjectPropertiesAsync",
  findObjectsByProperty: "FindObjectsByPropertyAsync",
};

const action = (name: string) => OBJECT_DOMAIN_DEFINITION.actions[name];

const approvalFor = (name: string) =>
  isApprovalRequired({
    toolName: "civil3d_object",
    action: name,
    capabilities: action(name).capabilities,
    safeForRetry: action(name).safeForRetry,
    requiresActiveDrawing: action(name).requiresActiveDrawing,
  });

beforeEach(() => {
  sendCommandMock.mockReset();
  sendCommandMock.mockResolvedValue({ ok: true });
});

describe("civil3d_object domain registration", () => {
  it("is one canonical multi-action tool and publishes no legacy aliases", () => {
    const entries = GENERATED_TOOL_CATALOG_ENTRIES.filter((entry) => entry.domain === "object");

    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe("civil3d_object");
    expect(entries[0].operations).toEqual([...OBJECT_ACTIONS]);
    expect(entries[0].pluginMethods).toEqual([
      "listObjectTypes",
      "getObjectProperties",
      "listObjectPropertyNames",
      "setObjectProperties",
      "findObjectsByProperty",
    ]);
    expect(entries[0].status).toBe("implemented");
    expect(entries[0].requiresActiveDrawing).toBe(true);
    // One action is not retryable, so the whole tool is not.
    expect(entries[0].safeForRetry).toBe(false);
  });

  it("exposes every action with its own manifest lookup", () => {
    for (const name of OBJECT_ACTIONS) {
      expect(findManifestAction("civil3d_object", name), name).toBeDefined();
      expect(findManifestAction("civil3d_object", name)!.actionDefinition.pluginMethods, name)
        .toHaveLength(1);
    }

    expect(OBJECT_DOMAIN_DEFINITION.exposures).toHaveLength(1);
    expect(OBJECT_DOMAIN_DEFINITION.exposures[0].supportedActions).toEqual([...OBJECT_ACTIONS]);
  });

  it("gates set_properties and leaves every read ungated", () => {
    expect(approvalFor("set_properties")).toBe(true);
    for (const name of ["list_types", "get_properties", "list_properties", "find_by_property"]) {
      expect(approvalFor(name), name).toBe(false);
      expect(action(name).requiresActiveDrawing).toBe(true);
      expect(action(name).safeForRetry).toBe(true);
    }

    expect(action("set_properties").capabilities).toEqual(["edit"]);
    expect(action("set_properties").safeForRetry).toBe(false);
  });

  it("annotates the tool as mutating, destructive and not idempotent", () => {
    const annotations = buildExposureAnnotations(
      OBJECT_DOMAIN_DEFINITION,
      OBJECT_DOMAIN_DEFINITION.exposures[0],
    );

    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(true);
    expect(annotations.idempotentHint).toBe(false);
  });

  it("documents the surface hang that shapes every read", () => {
    const description = OBJECT_DOMAIN_DEFINITION.exposures[0].description;

    expect(description).toContain("TinSurface");
    expect(description).toContain("120 s");
    expect(description).toContain("curated");
  });
});

describe("civil3d_object action inputs", () => {
  it("validates list_types", () => {
    expect(ListTypesArgsSchema.safeParse({ action: "list_types" }).success).toBe(true);
    expect(ListTypesArgsSchema.safeParse({ action: "list_types", contains: "Ali", limit: 50 }).success).toBe(true);
    expect(ListTypesArgsSchema.safeParse({
      action: "list_types",
      objectType: "Alignment",
      layer: "C-ROAD",
      limit: 25,
    }).success).toBe(true);
    expect(ListTypesArgsSchema.safeParse({ action: "list_types", limit: 0 }).success).toBe(false);
    expect(ListTypesArgsSchema.safeParse({ action: "list_types", limit: 1001 }).success).toBe(false);
  });

  it("validates get_properties", () => {
    expect(GetPropertiesArgsSchema.safeParse({ action: "get_properties", handle: "1A2B" }).success).toBe(true);
    expect(GetPropertiesArgsSchema.safeParse({ action: "get_properties" }).success).toBe(false);
    expect(GetPropertiesArgsSchema.safeParse({ action: "get_properties", handle: "" }).success).toBe(false);
  });

  it("validates list_properties", () => {
    expect(ListPropertiesArgsSchema.safeParse({ action: "list_properties", handle: "1A2B" }).success).toBe(true);
    expect(ListPropertiesArgsSchema.safeParse({ action: "list_properties" }).success).toBe(false);
  });

  it("validates set_properties and refuses a non-scalar value", () => {
    expect(SetPropertiesArgsSchema.safeParse({
      action: "set_properties",
      handle: "1A2B",
      properties: { StyleName: "Proposed", Layer: "C-ROAD", Description: null as never },
    }).success).toBe(false);

    expect(SetPropertiesArgsSchema.safeParse({
      action: "set_properties",
      handle: "1A2B",
      properties: { StyleName: "Proposed", Layer: "C-ROAD" },
    }).success).toBe(true);
    expect(SetPropertiesArgsSchema.safeParse({
      action: "set_properties",
      handle: "1A2B",
      properties: {},
    }).success).toBe(true);
    expect(SetPropertiesArgsSchema.safeParse({
      action: "set_properties",
      handle: "1A2B",
      properties: { Position: { x: 1, y: 2 } as never },
    }).success).toBe(false);
    expect(SetPropertiesArgsSchema.safeParse({
      action: "set_properties",
      handle: "1A2B",
    }).success).toBe(false);
  });

  it("validates find_by_property", () => {
    expect(FindByPropertyArgsSchema.safeParse({
      action: "find_by_property",
      property: "StyleName",
      value: "Proposed",
    }).success).toBe(true);
    expect(FindByPropertyArgsSchema.safeParse({
      action: "find_by_property",
      property: "StyleName",
      value: "Proposed",
      objectType: "Alignment",
      layer: "C-ROAD",
      limit: 10,
    }).success).toBe(true);
    expect(FindByPropertyArgsSchema.safeParse({
      action: "find_by_property",
      property: "StyleName",
    }).success).toBe(false);
    expect(FindByPropertyArgsSchema.safeParse({
      action: "find_by_property",
      value: "Proposed",
    }).success).toBe(false);
  });
});

describe("civil3d_object command dispatch", () => {
  it("sends listObjectTypes with the type filter, the layer and the limit", async () => {
    await action("list_types").execute({
      action: "list_types",
      objectType: "Alignment",
      layer: "C-ROAD",
      contains: "Ali",
      limit: 25,
    });

    expect(sendCommandMock).toHaveBeenCalledWith("listObjectTypes", {
      contains: "Ali",
      objectType: "Alignment",
      layer: "C-ROAD",
      limit: 25,
    });
  });

  it("sends getObjectProperties by handle only", async () => {
    await action("get_properties").execute({ action: "get_properties", handle: "1A2B" });

    expect(sendCommandMock).toHaveBeenCalledWith("getObjectProperties", { handle: "1A2B" });
  });

  it("sends listObjectPropertyNames by handle only", async () => {
    await action("list_properties").execute({ action: "list_properties", handle: "1A2B" });

    expect(sendCommandMock).toHaveBeenCalledWith("listObjectPropertyNames", { handle: "1A2B" });
  });

  it("sends setObjectProperties with the property map", async () => {
    await action("set_properties").execute({
      action: "set_properties",
      handle: "1A2B",
      properties: { StyleName: "Proposed" },
    });

    expect(sendCommandMock).toHaveBeenCalledWith("setObjectProperties", {
      handle: "1A2B",
      properties: { StyleName: "Proposed" },
    });
  });

  it("sends findObjectsByProperty with every filter", async () => {
    await action("find_by_property").execute({
      action: "find_by_property",
      property: "StyleName",
      value: "Proposed",
      objectType: "Alignment",
      layer: "C-ROAD",
      limit: 10,
    });

    expect(sendCommandMock).toHaveBeenCalledWith("findObjectsByProperty", {
      property: "StyleName",
      value: "Proposed",
      objectType: "Alignment",
      layer: "C-ROAD",
      limit: 10,
    });
  });

  it("returns the plugin result unchanged", async () => {
    sendCommandMock.mockResolvedValue({ total: 3, types: [{ objectType: "Line", count: 3 }] });

    await expect(action("list_types").execute({ action: "list_types" }))
      .resolves.toEqual({ total: 3, types: [{ objectType: "Line", count: 3 }] });
  });
});

describe("civil3d_object response contracts", () => {
  it("accepts a list_types payload with the matching objects and the type inventory", () => {
    expect(ListTypesResponseSchema.safeParse({
      contains: null,
      objectType: "Curve",
      layer: null,
      total: 4,
      typeCount: 2,
      truncated: false,
      typesTruncated: false,
      types: [{ objectType: "Line", count: 3 }, { objectType: "Arc", count: 1 }],
      objects: [
        { handle: "1A2B", objectType: "Line", name: null, layer: "C-ROAD" },
        { handle: "1A2C", objectType: "Arc", name: "ARC-1", layer: "C-ROAD" },
      ],
    }).success).toBe(true);
    expect(ListTypesResponseSchema.safeParse({ total: 0 }).success).toBe(false);
  });

  it("accepts a curated get_properties payload with a point value", () => {
    expect(GetPropertiesResponseSchema.safeParse({
      handle: "1A2B",
      objectType: "Line",
      layer: "C-ROAD",
      isSurface: false,
      curated: true,
      checkedPropertyCount: 7,
      properties: {
        Handle: "1A2B",
        StartPoint: { x: 1, y: 2, z: 0 },
        Length: 12.5,
        Closed: false,
      },
      note: "Curated property set for 'Line' (7 names); no property sweep ran.",
    }).success).toBe(true);
  });

  it("accepts the surface payload that carries the hang note", () => {
    const parsed = GetPropertiesResponseSchema.safeParse({
      handle: "2B3C",
      objectType: "TinSurface",
      layer: "C-TOPO",
      isSurface: true,
      curated: true,
      checkedPropertyCount: 5,
      properties: { Name: "EG", Handle: "2B3C", Layer: "C-TOPO", StyleName: "Contours" },
      note: "Surface objects use a curated safe property set",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts a list_properties payload", () => {
    expect(ListPropertiesResponseSchema.safeParse({
      handle: "1A2B",
      objectType: "Alignment",
      isSurface: false,
      curated: true,
      propertyCount: 2,
      properties: [
        { name: "Name", present: true, writable: true },
        { name: "AlignmentType", present: true, writable: false },
      ],
      note: "Curated property set for 'Alignment' (10 names); no property sweep ran.",
    }).success).toBe(true);
    expect(ListPropertiesResponseSchema.safeParse({
      handle: "1A2B",
      properties: [{ name: "Name" }],
    }).success).toBe(false);
  });

  it("accepts a set_properties payload", () => {
    expect(SetPropertiesResponseSchema.safeParse({
      handle: "1A2B",
      objectType: "Alignment",
      applied: [{ name: "StyleName", value: "Proposed" }],
    }).success).toBe(true);
  });

  it("accepts a find_by_property payload with a null name", () => {
    expect(FindByPropertyResponseSchema.safeParse({
      property: "StyleName",
      value: "Proposed",
      objectType: null,
      layer: null,
      scanned: 12,
      total: 1,
      truncated: false,
      objects: [{
        handle: "1A2B",
        objectType: "Alignment",
        name: null,
        layer: "C-ROAD",
        propertyValue: "Proposed",
      }],
    }).success).toBe(true);
  });
});

describe("civil3d_object plugin guards", () => {
  it("keeps the object command free of direct reflection", () => {
    const source = pluginSource("ObjectCommands.cs");
    const violations = source.split(/\r?\n/).filter((line) => directReflectionPattern.test(line));

    expect(violations).toEqual([]);
  });

  it("reads and writes only through the compatibility boundary", () => {
    const source = pluginSource("ObjectCommands.cs");

    expect(source).toContain("Civil3DCompatibility.GetPropertyValue");
    expect(source).toContain("Civil3DCompatibility.TrySetProperty");
    expect(source).not.toContain("GetType().GetProperties");
  });

  it("applies a curated allow-list before any read and guards surface types", () => {
    const source = pluginSource("ObjectCommands.cs");

    expect(source).toContain("CuratedPropertyNames");
    expect(source).toContain("PropertyNamesFor");
    expect(source).toContain("SurfacePropertyNames");
    expect(source).toContain("IsSurfaceObject");
    // The surface check is both by CLR type and by type name, so an unknown
    // surface-derived type cannot be swept either.
    expect(source).toContain("dbObject is CivilSurface");
    expect(source).toContain('objectType.IndexOf("Surface", StringComparison.OrdinalIgnoreCase)');
    // The only enumeration of an object's own scalar properties is gated by the
    // plain-entity allow-list, and it returns the surface set before it.
    expect(source).toContain("ScalarEnumerableTypeNames");
  });

  it("keeps the scalar enumeration off every surface type", () => {
    const source = pluginSource("ObjectCommands.cs");
    const start = source.indexOf("ScalarEnumerableTypeNames = new");
    const end = source.indexOf("};", start);
    const whitelist = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(whitelist).not.toContain("Surface");
  });

  it("refuses a non-scalar write before it applies anything", () => {
    const source = pluginSource("ObjectCommands.cs");

    expect(source).toContain("if (entry.Value is not JsonValue)");
    expect(source).toContain("Nothing was changed.");
  });

  it("names one C# method per declared plugin method", () => {
    const source = pluginSource("ObjectCommands.cs");

    for (const [pluginMethod, commandMethod] of Object.entries(pluginMethodToCommandMethod)) {
      expect(source, pluginMethod).toContain(`public static Task<object?> ${commandMethod}(`);
    }
  });

  it("has one dispatcher arm per declared plugin method, above the catch-all", () => {
    const dispatcher = pluginSource("CommandDispatcher.cs");
    const catchAll = dispatcher.indexOf("_ => throw new JsonRpcDispatchException");

    expect(catchAll).toBeGreaterThan(0);

    for (const [pluginMethod, commandMethod] of Object.entries(pluginMethodToCommandMethod)) {
      const arm = `"${pluginMethod}" => ObjectCommands.${commandMethod}(parameters),`;
      expect(dispatcher, pluginMethod).toContain(arm);
      expect(dispatcher.indexOf(arm), pluginMethod).toBeLessThan(catchAll);
    }
  });
});

describe("shared handle resolver", () => {
  it("exposes the one resolver in CivilObjectUtils", () => {
    const source = pluginSource("CivilObjectUtils.cs");

    expect(source).toContain("public static ObjectId? ResolveHandle(Transaction transaction, Database database, string handle)");
    // null means "this drawing has no such object"; every caller keeps its own error text.
    expect(source).toContain("return objectId.IsNull ? null : objectId;");
  });

  it("replaces all four inline resolvers in AcadCommands", () => {
    const source = pluginSource("AcadCommands.cs");

    expect(source).not.toContain("database.GetObjectId(false");
    expect(source.match(/CivilObjectUtils\.ResolveHandle\(transaction, database, /g) ?? []).toHaveLength(4);
    // The error text and the error codes are unchanged.
    expect(source).toContain('"CIVIL3D.INVALID_INPUT", $"Handle \'{handleValue}\' is not a valid hexadecimal handle."');
    expect(source).toContain('"CIVIL3D.OBJECT_NOT_FOUND", $"Entity with handle \'{handleValue}\' was not found."');
    expect(source).toContain('"CIVIL3D.OBJECT_NOT_FOUND", $"Entity with handle \'{handleText}\' was not found or is already erased."');
  });

  it("leaves the opposite-direction label resolver alone", () => {
    const source = pluginSource("LabelCommands.cs");

    // Different signature, different job: it turns an ObjectId into a handle.
    expect(source).toContain("private static string? ResolveHandle(Transaction transaction, ObjectId objectId)");
  });
});
