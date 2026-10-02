/**
 * Field-book (.fbk) parser schemas for the `civil3d_survey` domain -- item 2 of the port plan.
 *
 * The parser itself is plugin C# (`Civil3D-MCP-Plugin/FbkCommands.cs`), ported from the donor
 * KevinGriffin/new_civil3d_mcp `Civil3dMcpBridge.cs` (`ParseFbkFile` / `ParseFbkLine` /
 * `DmsPackedToRadians`). These schemas pin the contract between that command and the MCP tool, so a
 * change on either side fails loudly instead of silently returning a different shape.
 *
 * SCOPE: the parser only. The donor's FBK IMPORT drives the AutoCAD `IMPORTFIELDBOOK` command and
 * the Survey COM API, which are version-pinned to Civil 3D 2026 through two Interop assemblies this
 * fork does not reference. No import is exposed, here or in C#.
 *
 * WHAT THE FORMAT CARRIES AND WHAT THIS PARSER READS: the donor parser recognizes coordinate
 * records (NEZ), setups (STN), backsights (BS), azimuths (AZ), target heights (PRISM) and
 * observations (F1/F2). It recognizes NO figure record -- `FbkParseLine` has no figure keyword and
 * the donor's parse result has no figure collection -- and the donor ships no .fbk sample, so there
 * is no figure grammar to port or verify. Nothing is exposed for figures.
 */
import { z } from "zod";

/** One keyword record of the field book. `type` mirrors the C# `FbkRecordType` enum names. */
export const FBK_RECORD_TYPES = [
  "Nez",
  "Stn",
  "Bs",
  "Az",
  "Prism",
  "F1",
  "F2",
  "Job",
  "Ignored",
  "Unknown",
] as const;

/** The face token an observation line may carry before the point number. */
export const FBK_ANGLE_FLAVORS = ["VA", "ZA", "ZE"] as const;

export const FbkRecordSchema = z.object({
  /** 1-based source line number. */
  line: z.number().int(),
  type: z.enum(FBK_RECORD_TYPES),
  pt: z.number().int().nullable(),
  /** Northing, exactly as the field book writes it (NEZ order). */
  n: z.number().nullable(),
  /** Easting. */
  e: z.number().nullable(),
  /** Elevation. */
  z: z.number().nullable(),
  /** Instrument height (STN). */
  hi: z.number().nullable(),
  /** Backsight circle reading, still DMS-packed (BS). */
  circle: z.number().nullable(),
  azFrom: z.number().int().nullable(),
  azTo: z.number().int().nullable(),
  /** Azimuth as written, DMS-packed DDD.MMSSsss (AZ). */
  azDms: z.number().nullable(),
  /** Derived from azDms: decimal degrees. */
  azimuthDegrees: z.number().nullable(),
  /** Target height in force when this observation was taken. */
  prismHeight: z.number().nullable(),
  angleFlavor: z.enum(FBK_ANGLE_FLAVORS).nullable(),
  /** Horizontal angle, DMS-packed (F1/F2). */
  ha: z.number().nullable(),
  /** Slope distance (F1/F2). */
  sd: z.number().nullable(),
  /** Vertical angle, DMS-packed (F1/F2). */
  va: z.number().nullable(),
  /** Derived from ha: decimal degrees. */
  haDegrees: z.number().nullable(),
  /** Derived from va: decimal degrees. */
  vaDegrees: z.number().nullable(),
  desc: z.string().nullable(),
  /** Set when the line could not be parsed, or its keyword is unknown. */
  warning: z.string().nullable(),
});

/** A coordinate point (NEZ) as written in the field book. */
export const FbkControlPointSchema = z.object({
  pt: z.number().int().nullable(),
  n: z.number().nullable(),
  e: z.number().nullable(),
  z: z.number().nullable(),
  desc: z.string().nullable(),
});

/** The field-book structure: one station setup and the observations it carries. */
export const FbkSetupSchema = z.object({
  stationPt: z.number().int(),
  instrumentHeight: z.number(),
  description: z.string().nullable(),
  backsightPt: z.number().int().nullable(),
  /** As written, DMS-packed. */
  backsightCircleDms: z.number().nullable(),
  /** Derived from backsightCircleDms: decimal degrees. */
  backsightCircleDegrees: z.number().nullable(),
  azimuthDms: z.number().nullable(),
  azimuthDegrees: z.number().nullable(),
  azFrom: z.number().int().nullable(),
  azTo: z.number().int().nullable(),
  observationCount: z.number().int(),
  /** Source line numbers of this setup's observations, in file order. */
  observationLines: z.array(z.number().int()),
});

/**
 * The `parseFbk` plugin result. `.passthrough()` keeps a future added field from breaking a caller,
 * while every field listed here is required, so a lost or renamed field fails the validation.
 */
export const FBK_PARSE_RESPONSE_SCHEMA = z.object({
  /** Absolute, import-root-checked path the plugin actually read. */
  filePath: z.string(),
  totalLines: z.number().int(),
  recordCount: z.number().int(),
  controlPointCount: z.number().int(),
  setupCount: z.number().int(),
  observationCount: z.number().int(),
  /** One entry per unparseable / unrecognized line, as `Line <n>: <reason>`. */
  warnings: z.array(z.string()),
  controlPoints: z.array(FbkControlPointSchema),
  setups: z.array(FbkSetupSchema),
  records: z.array(FbkRecordSchema),
}).passthrough();

/** Input of the `fbk_parse` action. The plugin's FileBoundary owns the path rules (import roots, .fbk). */
export const FbkParseArgsSchema = z.object({
  action: z.literal("fbk_parse"),
  filePath: z.string().min(1),
});
