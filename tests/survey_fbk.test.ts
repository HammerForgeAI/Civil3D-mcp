import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURVEY_DOMAIN_DEFINITION } from "../src/tools/domains/surveyDomain.js";
import {
  FBK_ANGLE_FLAVORS,
  FBK_PARSE_RESPONSE_SCHEMA,
  FBK_RECORD_TYPES,
  FbkControlPointSchema,
  FbkParseArgsSchema,
  FbkRecordSchema,
  FbkSetupSchema,
} from "../src/tools/domains/surveyFbk.js";
import { GENERATED_TOOL_CATALOG_ENTRIES } from "../src/tools/toolManifest.js";

/**
 * Item 2 of the P4 port: the field-book (.fbk) parser in the `civil3d_survey` domain.
 *
 * The parser itself is plugin C# (`Civil3D-MCP-Plugin/FbkCommands.cs`, ported from the donor
 * KevinGriffin/new_civil3d_mcp, MIT). These tests pin the MCP contract at the schema and
 * parse-shape level, and pin the two sides together so a rename on one side cannot pass silently.
 *
 * DELIBERATE OMISSION: the donor parser recognizes no figure record, so no figure collection is
 * exposed. The IMPORT (AutoCAD IMPORTFIELDBOOK + Survey COM Interop) is not exposed either.
 */

const pluginSource = readFileSync(new URL("../Civil3D-MCP-Plugin/FbkCommands.cs", import.meta.url), "utf8");

/** The command's own code, with the explanatory comments removed. */
const pluginCode = pluginSource
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

type Loose = Record<string, unknown>;

const record = (over: Loose): Loose => ({
  line: 1,
  type: "Job",
  pt: null,
  n: null,
  e: null,
  z: null,
  hi: null,
  circle: null,
  azFrom: null,
  azTo: null,
  azDms: null,
  azimuthDegrees: null,
  prismHeight: null,
  angleFlavor: null,
  ha: null,
  sd: null,
  va: null,
  haDegrees: null,
  vaDegrees: null,
  desc: null,
  warning: null,
  ...over,
});

/**
 * One realistic parseFbk result, built by hand from this field book, so the fixture documents the
 * contract instead of echoing the C# code:
 *
 *   ! exported 2026-10-02
 *   JOB "VILLA ONE"
 *   UNIT 1 1
 *   NEZ 100 5000.000 2000.000 100.000 "BM 1"
 *   NEZ 101 5100.000 2100.000 101.500 "CP 2"
 *   STN 100 1.520 "STATION 1"
 *   BS  101 0.00000
 *   AZ  100 101 45.30000
 *   PRISM 1.500
 *   F1 VA 101 86.43340 120.000 91.20000 "CP 2"
 *   F2 VA 101 266.43340 120.010 268.40000 "CP 2"
 */
const villaOneParse: Loose = {
  filePath: "/imports/VILLA ONE.fbk",
  totalLines: 11,
  recordCount: 10,
  controlPointCount: 2,
  setupCount: 1,
  observationCount: 2,
  warnings: [],
  controlPoints: [
    { pt: 100, n: 5000, e: 2000, z: 100, desc: "BM 1" },
    { pt: 101, n: 5100, e: 2100, z: 101.5, desc: "CP 2" },
  ],
  setups: [{
    stationPt: 100,
    instrumentHeight: 1.52,
    description: "STATION 1",
    backsightPt: 101,
    backsightCircleDms: 0,
    backsightCircleDegrees: 0,
    azimuthDms: 45.3,
    azimuthDegrees: 45.5,
    azFrom: 100,
    azTo: 101,
    observationCount: 2,
    observationLines: [10, 11],
  }],
  records: [
    record({ line: 2, type: "Job", desc: "VILLA ONE" }),
    record({ line: 3, type: "Ignored" }),
    record({ line: 4, type: "Nez", pt: 100, n: 5000, e: 2000, z: 100, desc: "BM 1" }),
    record({ line: 5, type: "Nez", pt: 101, n: 5100, e: 2100, z: 101.5, desc: "CP 2" }),
    record({ line: 6, type: "Stn", pt: 100, hi: 1.52, desc: "STATION 1" }),
    record({ line: 7, type: "Bs", pt: 101, circle: 0 }),
    record({ line: 8, type: "Az", azFrom: 100, azTo: 101, azDms: 45.3, azimuthDegrees: 45.5 }),
    record({ line: 9, type: "Prism", prismHeight: 1.5 }),
    record({
      line: 10,
      type: "F1",
      pt: 101,
      angleFlavor: "VA",
      ha: 86.4334,
      sd: 120,
      va: 91.2,
      haDegrees: 86 + 43 / 60 + 34 / 3600,
      vaDegrees: 91 + 20 / 60,
      prismHeight: 1.5,
      desc: "CP 2",
    }),
    record({
      line: 11,
      type: "F2",
      pt: 101,
      angleFlavor: "VA",
      ha: 266.4334,
      sd: 120.01,
      va: 268.4,
      haDegrees: 266 + 43 / 60 + 34 / 3600,
      vaDegrees: 268 + 40 / 60,
      prismHeight: 1.5,
      desc: "CP 2",
    }),
  ],
};

describe("civil3d_survey fbk_parse action", () => {
  const action = SURVEY_DOMAIN_DEFINITION.actions.fbk_parse;

  it("is added to the existing survey domain as a read-only, drawing-independent action", () => {
    expect(action).toBeDefined();
    expect(action.action).toBe("fbk_parse");
    expect(action.pluginMethods).toEqual(["parseFbk"]);
    expect(action.capabilities).toEqual(["query", "inspect"]);
    expect(action.requiresActiveDrawing).toBe(false);
    expect(action.safeForRetry).toBe(true);
  });

  it("requires the action literal and a non-empty file path", () => {
    expect(FbkParseArgsSchema.safeParse({ action: "fbk_parse", filePath: "/imports/x.fbk" }).success).toBe(true);
    expect(FbkParseArgsSchema.safeParse({ action: "fbk_parse" }).success).toBe(false);
    expect(FbkParseArgsSchema.safeParse({ action: "fbk_parse", filePath: "" }).success).toBe(false);
    expect(FbkParseArgsSchema.safeParse({ action: "figure_list", filePath: "/imports/x.fbk" }).success).toBe(false);
  });

  it("is reachable through the canonical survey tool and its own dedicated tool", () => {
    const canonical = SURVEY_DOMAIN_DEFINITION.exposures.find((e) => e.toolName === "civil3d_survey")!;
    const dedicated = SURVEY_DOMAIN_DEFINITION.exposures.find((e) => e.toolName === "civil3d_survey_fbk_parse")!;

    expect(canonical.supportedActions).toContain("fbk_parse");
    expect(Object.keys(canonical.inputShape)).toContain("filePath");
    expect(dedicated.supportedActions).toEqual(["fbk_parse"]);
    expect(dedicated.resolveAction({ filePath: "/imports/x.fbk" })).toEqual({
      action: "fbk_parse",
      args: { action: "fbk_parse", filePath: "/imports/x.fbk" },
    });
  });

  it("is published in the generated catalog with parseFbk as its only plugin method", () => {
    const canonical = GENERATED_TOOL_CATALOG_ENTRIES.find((e) => e.toolName === "civil3d_survey")!;
    const dedicated = GENERATED_TOOL_CATALOG_ENTRIES.find((e) => e.toolName === "civil3d_survey_fbk_parse")!;

    expect(canonical.operations).toContain("fbk_parse");
    expect(dedicated.pluginMethods).toEqual(["parseFbk"]);
    expect(dedicated.requiresActiveDrawing).toBe(false);
  });
});

describe("fbk_parse response shape", () => {
  it("accepts the full parse of a field book", () => {
    const parsed = FBK_PARSE_RESPONSE_SCHEMA.parse(villaOneParse);

    expect(parsed.recordCount).toBe(10);
    expect(parsed.controlPoints).toHaveLength(2);
    expect(parsed.setups[0].observationLines).toEqual([10, 11]);

    const [, , , , , , , , f1, f2] = parsed.records;
    expect(f1.type).toBe("F1");
    expect(f2.type).toBe("F2");
    // The derivation the donor parser supports: DDD.MMSSsss decoded to decimal degrees,
    // 86.43340 -> 86 degrees 43 minutes 34.0 seconds
    expect(f1.haDegrees).toBeCloseTo(86 + 43 / 60 + 34 / 3600, 9);
    expect(f1.vaDegrees).toBeCloseTo(91.33333333333333, 9);
    expect(f2.haDegrees).toBeCloseTo(266.7261111111111, 9);
    // 45.30000 -> 45 degrees 30 minutes
    expect(parsed.records[6].azimuthDegrees).toBeCloseTo(45.5, 9);
    expect(parsed.setups[0].azimuthDegrees).toBeCloseTo(45.5, 9);
    // the target height in force is stamped onto each observation
    expect(f1.prismHeight).toBe(1.5);
    expect(f2.prismHeight).toBe(1.5);
  });

  it("accepts a field book whose structure is only warnings, with empty point and setup lists", () => {
    const degenerate = {
      filePath: "/imports/broken.fbk",
      totalLines: 4,
      recordCount: 3,
      controlPointCount: 0,
      setupCount: 0,
      observationCount: 0,
      warnings: ["Line 1: BS before STN, ignored", "Line 4: Unrecognized keyword: FIG"],
      controlPoints: [],
      setups: [],
      records: [
        record({ line: 1, type: "Bs", pt: 101, circle: 0 }),
        record({ line: 2, type: "Job", desc: "VILLA ONE" }),
        record({ line: 4, type: "Unknown", warning: "Unrecognized keyword: FIG" }),
      ],
    };

    const parsed = FBK_PARSE_RESPONSE_SCHEMA.parse(degenerate);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.records[2].warning).toBe("Unrecognized keyword: FIG");
  });

  it("rejects a result that lost the field-book structure", () => {
    expect(FBK_PARSE_RESPONSE_SCHEMA.safeParse({ ...villaOneParse, setups: undefined }).success).toBe(false);
    expect(FBK_PARSE_RESPONSE_SCHEMA.safeParse({ ...villaOneParse, records: "10" }).success).toBe(false);
    expect(FBK_PARSE_RESPONSE_SCHEMA.safeParse({ ...villaOneParse, warnings: [1, 2] }).success).toBe(false);
    expect(FBK_PARSE_RESPONSE_SCHEMA.safeParse({ ...villaOneParse, records: [{ line: 1, type: "Fig" }] }).success).toBe(false);
  });

  it("exposes no figure collection, because the parser recognizes no figure record", () => {
    expect(FBK_RECORD_TYPES).not.toContain("Fig");
    expect(Object.keys(FBK_PARSE_RESPONSE_SCHEMA.shape)).not.toContain("figures");
    expect(Object.keys(FBK_PARSE_RESPONSE_SCHEMA.shape)).not.toContain("figureCount");
  });
});

describe("fbk_parse schema and plugin command stay in step", () => {
  it("reads its input file through FileBoundary and touches no COM or Interop object", () => {
    expect(pluginCode).toContain("FileBoundary.ResolveImportPath");
    expect(pluginCode).toContain('".fbk"');
    expect(pluginCode).not.toMatch(/AeccSurvey|Interop|IMPORTFIELDBOOK/i);
  });

  it("emits every field the response schema requires", () => {
    const emitters: Array<[string, string[]]> = [
      ["top level", Object.keys(FBK_PARSE_RESPONSE_SCHEMA.shape)],
      ["record", Object.keys(FbkRecordSchema.shape)],
      ["setup", Object.keys(FbkSetupSchema.shape)],
      ["control point", Object.keys(FbkControlPointSchema.shape)],
    ];

    for (const [label, keys] of emitters) {
      for (const key of keys) {
        expect(pluginSource, `${label} field "${key}" is not emitted by FbkCommands.cs`).toContain(`["${key}"]`);
      }
    }
  });

  it("declares every record type and angle flavour the schema allows", () => {
    const enumBody = pluginSource.slice(
      pluginSource.indexOf("private enum FbkRecordType"),
      pluginSource.indexOf("private sealed class FbkRecord"),
    );

    for (const type of FBK_RECORD_TYPES) {
      expect(enumBody, `record type "${type}" is missing from the C# enum`).toMatch(new RegExp(`\\b${type},`));
    }
    for (const flavor of FBK_ANGLE_FLAVORS) {
      expect(pluginSource, `angle flavour "${flavor}" is not recognized by the C# parser`).toContain(`"${flavor}"`);
    }
  });

  it("is bound to a dispatcher arm", () => {
    const dispatcher = readFileSync(
      new URL("../Civil3D-MCP-Plugin/CommandDispatcher.cs", import.meta.url),
      "utf8",
    );
    expect(dispatcher).toContain('"parseFbk" => FbkCommands.ParseFbkAsync(parameters),');
  });
});
